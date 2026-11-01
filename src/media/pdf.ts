// pdf.js, bundled (no CDN). Loaded only when a PDF is opened. The worker is served from 'self'
// and eval is turned off, so the strict CSP needs no 'unsafe-eval'. cmaps, standard fonts and
// wasm decoders are copied to pdfjs/ next to the app by the vite plugin in vite.config.ts.
// pdf.js 6 removed its eval-based font path (and with it the isEvalSupported option): there is
// no eval or new Function in the bundled build, so the CSP needs no 'unsafe-eval'.
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export type PDFDocumentProxy = Awaited<PDFDocumentLoadingTask['promise']>

/** Call loadingTask.destroy() when done; it also stops the worker. */
export function openPdf(data: Uint8Array<ArrayBuffer>): PDFDocumentLoadingTask {
  const base = new URL('pdfjs/', document.baseURI).href
  return getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    enableXfa: false,
  })
}

/** Renders one page into a canvas, scaled to the given CSS width. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): Promise<void> {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`
  await page.render({ canvas, viewport }).promise
  page.cleanup()
}
