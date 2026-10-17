// HU-4: evidencia de aprobación. P0 = aprobacion.txt con sha256; P1 = aprobacion.pdf con el mismo contenido.
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import type { AprobacionArchivo } from "./tipos"

/** Contenido canónico: el hash se calcula siempre sobre este mismo texto. */
export function contenidoEvidencia(a: AprobacionArchivo): string {
  return [
    `De: ${a.de}`,
    `Para: ${a.para ?? ""}`,
    `CC: ${(a.cc ?? []).join(", ")}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto ?? ""}`,
    "",
    a.cuerpo,
    "",
  ].join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

function partirLinea(linea: string, maximo: number): string[] {
  if (linea.length <= maximo) return [linea]
  const partes: string[] = []
  let resto = linea
  while (resto.length > maximo) {
    const corte = resto.lastIndexOf(" ", maximo)
    const i = corte > 0 ? corte : maximo
    partes.push(resto.slice(0, i))
    resto = resto.slice(i).trimStart()
  }
  partes.push(resto)
  return partes
}

async function escribirPdf(ruta: string, titulo: string, contenido: string, hash: string): Promise<void> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(titulo)
  pdf.setCreationDate(new Date(0)) // determinista
  pdf.setModificationDate(new Date(0))
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pagina = pdf.addPage([612, 792])
  let y = 740
  pagina.drawText(titulo, { x: 50, y, size: 14, font: negrita })
  y -= 30
  const lineas = contenido.split("\n").flatMap((l) => partirLinea(l, 90))
  for (const linea of [...lineas, "", `sha256 del contenido: ${hash}`]) {
    if (y < 50) break
    pagina.drawText(linea, { x: 50, y, size: 10, font: fuente })
    y -= 14
  }
  await writeFile(ruta, await pdf.save())
}

export async function escribirEvidencia(
  directorio: string,
  caso: string,
  aprobacion: AprobacionArchivo,
): Promise<{ ruta: string; ruta_pdf: string; sha256: string }> {
  const contenido = contenidoEvidencia(aprobacion)
  const hash = sha256(contenido)
  const carpeta = path.join(directorio, "out", caso)
  await mkdir(carpeta, { recursive: true })
  await writeFile(path.join(carpeta, "aprobacion.txt"), `${contenido}---\nsha256: ${hash}\n`, "utf8")
  await escribirPdf(path.join(carpeta, "aprobacion.pdf"), "Evidencia de aprobación", contenido, hash)
  return { ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256: hash }
}
