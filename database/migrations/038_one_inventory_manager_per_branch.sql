-- At most one active Inventory Manager user per branch (multi-branch companies OK).
-- role_id 1 = inventory_manager (see server/src/config/constants.js ROLE_IDS).

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_im_per_branch
  ON users (tenant_id, branch_id)
  WHERE role_id = 1
    AND is_active = true
    AND branch_id IS NOT NULL;
