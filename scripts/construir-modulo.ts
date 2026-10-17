// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md a partir de las MISMAS fuentes que usa
// la aplicación (agent/prompt.md y src/knowledge/ordenes-compra.md). modulo/tools/oc.ts reexporta
// src/tools/oc.ts. Así las tres piezas nunca divergen (PRD 9.4).
// Ejecutar: npm run modulo   ·   Verificar sin escribir: npm run modulo -- --verificar
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

const raiz = process.cwd()
const verificar = process.argv.includes("--verificar")

async function generar(): Promise<Record<string, string>> {
  const prompt = await readFile(path.join(raiz, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return {
    "modulo/agent.md": [
      "---",
      "description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de correo (solicitud, cotización, aprobación, factura), con controles RC1–RC10 y confirmación humana.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
    ].join("\n"),
    "modulo/skill/ordenes-compra/SKILL.md": [
      "---",
      "name: ordenes-compra",
      "description: Conocimiento del proceso de órdenes de compra de Periferia — reglas de control RC1–RC10, glosario (OC retroactiva, indicadores de IVA, condiciones de pago) y qué devolver al humano en cada excepción.",
      "---",
      "",
      conocimiento,
    ].join("\n"),
    "modulo/tools/oc.ts": [
      "// Mismas herramientas que usa la aplicación: reexporta src/tools/oc.ts (no es una copia).",
      "// Importables sin el servidor: import * as oc from \"./modulo/tools/oc\"",
      'export * from "../../src/tools/oc"',
      "",
    ].join("\n"),
  }
}

async function main(): Promise<void> {
  const archivos = await generar()
  let diferentes = 0
  for (const [relativo, contenido] of Object.entries(archivos)) {
    const ruta = path.join(raiz, relativo)
    const actual = existsSync(ruta) ? await readFile(ruta, "utf8") : null
    if (verificar) {
      const igual = actual === contenido
      if (!igual) diferentes++
      console.log(`${igual ? "✔" : "✖"} ${relativo}${igual ? "" : " (desactualizado: ejecute npm run modulo)"}`)
      continue
    }
    await mkdir(path.dirname(ruta), { recursive: true })
    await writeFile(ruta, contenido, "utf8")
    console.log(`escrito ${relativo}`)
  }
  if (diferentes > 0) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
