import bwipjs from 'bwip-js'

export function generateItemCode(prefix = 'ITM') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`
}

export function generateBarcodeValue(prefix = '890') {
  const body = String(Date.now()).slice(-10)
  return `${prefix}${body}`.slice(0, 13)
}

export async function renderBarcodePng(text) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: String(text),
    scale: 3,
    height: 10,
    paddingwidth: 12,
    paddingheight: 12,
    backgroundcolor: 'FFFFFF',
    includetext: true,
    textxalign: 'center',
  })
}
