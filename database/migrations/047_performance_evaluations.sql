-- Append-only performance evaluations + versioned scoring scales (TL Performance Detail)

CREATE TABLE IF NOT EXISTS scoring_criteria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_scoring_criteria_tenant
  ON scoring_criteria (tenant_id);

CREATE TABLE IF NOT EXISTS scoring_scale_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_summary TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_scoring_scale_versions_tenant_effective
  ON scoring_scale_versions (tenant_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS scoring_scale_version_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES scoring_scale_versions(id) ON DELETE CASCADE,
  criterion_id UUID NOT NULL REFERENCES scoring_criteria(id),
  criterion_name TEXT NOT NULL,
  max_score INTEGER NOT NULL CHECK (max_score >= 1),
  UNIQUE (version_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_scoring_scale_version_items_version
  ON scoring_scale_version_items (version_id);

CREATE TABLE IF NOT EXISTS performance_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id),
  scale_version_id UUID NOT NULL REFERENCES scoring_scale_versions(id),
  total_score NUMERIC(8,2) NOT NULL,
  rating_label TEXT NOT NULL,
  remarks TEXT,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_performance_evaluations_staff_scored
  ON performance_evaluations (tenant_id, staff_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_performance_evaluations_branch
  ON performance_evaluations (tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS performance_evaluation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID NOT NULL REFERENCES performance_evaluations(id) ON DELETE CASCADE,
  criterion_id UUID NOT NULL REFERENCES scoring_criteria(id),
  criterion_name TEXT NOT NULL,
  max_score INTEGER NOT NULL,
  points NUMERIC(8,2) NOT NULL,
  UNIQUE (evaluation_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_performance_evaluation_items_eval
  ON performance_evaluation_items (evaluation_id);

-- Backfill: criteria + v1 scale (normalize maxes to 100) + one evaluation per scored staff
DO $$
DECLARE
  t RECORD;
  v_id UUID;
  sum_max NUMERIC;
  item RECORD;
  assigned INT;
  target INT;
  staff_row RECORD;
  eval_id UUID;
  actual_sum NUMERIC;
  max_sum NUMERIC;
  total_pct NUMERIC;
  rating TEXT;
  pts NUMERIC;
  new_max INT;
BEGIN
  FOR t IN SELECT DISTINCT tenant_id FROM scoring_scales LOOP
    v_id := NULL;

    -- Stable criteria IDs reuse scoring_scales.id for mapping legacy scores
    INSERT INTO scoring_criteria (id, tenant_id, code, name)
    SELECT ss.id, ss.tenant_id, ss.code, ss.name
    FROM scoring_scales ss
    WHERE ss.tenant_id = t.tenant_id
    ON CONFLICT (tenant_id, code) DO NOTHING;

    -- Reuse existing v1 when a prior partial migrate created it
    SELECT sv.id INTO v_id
    FROM scoring_scale_versions sv
    WHERE sv.tenant_id = t.tenant_id
    ORDER BY sv.version_number ASC
    LIMIT 1;

    IF v_id IS NULL THEN
      SELECT COALESCE(SUM(ss.max_points), 0)::numeric INTO sum_max
      FROM scoring_scales ss
      WHERE ss.tenant_id = t.tenant_id
        AND COALESCE(ss.is_active, true) = true;

      IF sum_max <= 0 THEN
        CONTINUE;
      END IF;

      INSERT INTO scoring_scale_versions (
        tenant_id, version_number, effective_from, change_summary
      )
      VALUES (
        t.tenant_id, 1, now(), 'Initial scale migrated from scoring factors'
      )
      RETURNING id INTO v_id;

      assigned := 0;
      FOR item IN
        SELECT ss.id, ss.name, ss.max_points,
               ROW_NUMBER() OVER (ORDER BY ss.name) AS rn,
               COUNT(*) OVER () AS cnt
        FROM scoring_scales ss
        WHERE ss.tenant_id = t.tenant_id
          AND COALESCE(ss.is_active, true) = true
        ORDER BY ss.name
      LOOP
        IF item.rn = item.cnt THEN
          new_max := GREATEST(1, 100 - assigned);
        ELSE
          new_max := GREATEST(1, ROUND(item.max_points::numeric * 100.0 / sum_max)::int);
          IF assigned + new_max > 100 - (item.cnt - item.rn) THEN
            new_max := GREATEST(1, 100 - (item.cnt - item.rn) - assigned);
          END IF;
          assigned := assigned + new_max;
        END IF;

        INSERT INTO scoring_scale_version_items (
          version_id, criterion_id, criterion_name, max_score
        )
        VALUES (v_id, item.id, item.name, new_max)
        ON CONFLICT (version_id, criterion_id) DO NOTHING;
      END LOOP;
    END IF;

    -- Skip evaluation backfill when this tenant already has evaluations
    IF EXISTS (
      SELECT 1 FROM performance_evaluations pe WHERE pe.tenant_id = t.tenant_id
    ) THEN
      CONTINUE;
    END IF;

    -- One evaluation per staff that has legacy scores on active factors
    FOR staff_row IN
      SELECT
        ps.staff_id,
        s.branch_id,
        (array_agg(ps.created_by ORDER BY ps.scored_on DESC, ps.id DESC))[1] AS created_by,
        MAX(ps.scored_on) AS scored_on
      FROM performance_scores ps
      INNER JOIN staff s ON s.id = ps.staff_id AND s.tenant_id = ps.tenant_id
      INNER JOIN scoring_scale_version_items vi ON vi.criterion_id = ps.scale_id AND vi.version_id = v_id
      WHERE ps.tenant_id = t.tenant_id
      GROUP BY ps.staff_id, s.branch_id
    LOOP
      actual_sum := 0;
      max_sum := 0;

      -- Pre-calc total % using scaled points vs version maxes
      FOR item IN
        SELECT vi.criterion_id, vi.max_score, vi.criterion_name,
               COALESCE((
                 SELECT lp.points
                 FROM (
                   SELECT ps.points
                   FROM performance_scores ps
                   WHERE ps.tenant_id = t.tenant_id
                     AND ps.staff_id = staff_row.staff_id
                     AND ps.scale_id = vi.criterion_id
                   ORDER BY ps.scored_on DESC, ps.id DESC
                   LIMIT 1
                 ) lp
               ), 0) AS old_points,
               COALESCE((
                 SELECT ss.max_points
                 FROM scoring_scales ss
                 WHERE ss.tenant_id = t.tenant_id AND ss.id = vi.criterion_id
               ), vi.max_score) AS old_max
        FROM scoring_scale_version_items vi
        WHERE vi.version_id = v_id
      LOOP
        pts := LEAST(
          item.max_score::numeric,
          ROUND(item.old_points::numeric * item.max_score::numeric / NULLIF(item.old_max, 0), 2)
        );
        actual_sum := actual_sum + pts;
        max_sum := max_sum + item.max_score;
      END LOOP;

      IF max_sum <= 0 THEN
        CONTINUE;
      END IF;

      total_pct := ROUND((actual_sum / max_sum) * 100, 2);
      IF total_pct >= 80 THEN
        rating := 'Excellent';
      ELSIF total_pct >= 60 THEN
        rating := 'Good';
      ELSIF total_pct >= 40 THEN
        rating := 'Fair';
      ELSE
        rating := 'Poor';
      END IF;

      INSERT INTO performance_evaluations (
        tenant_id, staff_id, branch_id, scale_version_id,
        total_score, rating_label, scored_at, created_by
      )
      VALUES (
        t.tenant_id,
        staff_row.staff_id,
        staff_row.branch_id,
        v_id,
        total_pct,
        rating,
        COALESCE(staff_row.scored_on::timestamptz, now()),
        staff_row.created_by
      )
      RETURNING id INTO eval_id;

      INSERT INTO performance_evaluation_items (
        evaluation_id, criterion_id, criterion_name, max_score, points
      )
      SELECT
        eval_id,
        vi.criterion_id,
        vi.criterion_name,
        vi.max_score,
        LEAST(
          vi.max_score::numeric,
          ROUND(
            COALESCE((
              SELECT lp.points
              FROM (
                SELECT ps.points
                FROM performance_scores ps
                WHERE ps.tenant_id = t.tenant_id
                  AND ps.staff_id = staff_row.staff_id
                  AND ps.scale_id = vi.criterion_id
                ORDER BY ps.scored_on DESC, ps.id DESC
                LIMIT 1
              ) lp
            ), 0)::numeric
            * vi.max_score::numeric
            / NULLIF((
              SELECT ss.max_points
              FROM scoring_scales ss
              WHERE ss.tenant_id = t.tenant_id AND ss.id = vi.criterion_id
            ), 0),
            2
          )
        )
      FROM scoring_scale_version_items vi
      WHERE vi.version_id = v_id;
    END LOOP;
  END LOOP;
END $$;
