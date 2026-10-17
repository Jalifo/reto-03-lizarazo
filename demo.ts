// demo.ts — Verificación sin modelo de lenguaje (PRD 6.6).
// Llama directamente a las herramientas de src/tools/oc.ts para los 6 casos.
// Ejecutar: npm run demo   (o: bun run demo.ts)
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import * as oc from "./src/tools/oc"
import type { ContextoHerramienta, Hallazgo, OrdenCompra } from "./src/oc/tipos"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string; bloqueos?: Hallazgo[]; confirmaciones?: Hallazgo[] }
type DatosValidacion = { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean; derivados: Record<string, { valor: string }> }
type DatosCreacion = { numero_oc: string; idempotente: boolean; retroactiva: boolean; evidencia?: string }

const ctx: ContextoHerramienta = { directory: process.cwd(), sessionId: "demo" }
const leer = <T>(json: string) => JSON.parse(json) as Respuesta<T>
const lista = (h: Hallazgo[]) => (h.length ? h.map((x) => `${x.regla}:${x.codigo}`).join(", ") : "—")

async function payloadDe(caso: string): Promise<OrdenCompra | undefined> {
  const r = leer<{ orden: OrdenCompra }>(await oc.construir_payload.execute({ caso }, ctx))
  return r.ok ? r.data.orden : undefined
}

async function intentarCrear(caso: string, confirmado?: boolean): Promise<string> {
  const payload = await payloadDe(caso)
  const r = leer<DatosCreacion>(await oc.crear.execute({ caso, payload, confirmado }, ctx))
  if (r.ok) return `OC ${r.data.numero_oc}${r.data.idempotente ? " (idempotente: ya existía)" : " creada"}`
  return `NO creada → ${r.error}`
}

async function main(): Promise<void> {
  await rm(path.join(ctx.directory, "out"), { recursive: true, force: true }) // determinismo
  const casos = (await readdir(path.join(ctx.directory, "fixtures", "reto-03", "solicitudes"))).sort()

  console.log("\n=== 1. Procesamiento de los 6 casos (sin confirmar nada) ===")
  for (const caso of casos) {
    const v = leer<DatosValidacion>(await oc.validar.execute({ caso }, ctx))
    console.log(`\n▶ ${caso}`)
    if (!v.ok) {
      console.log(`  error: ${v.error}`)
      continue
    }
    const derivados = Object.entries(v.data.derivados).map(([k, d]) => `${k}=${d.valor}`).join(", ") || "—"
    console.log(`  apta: ${v.data.apta}   retroactiva: ${v.data.retroactiva}   derivados: ${derivados}`)
    console.log(`  bloqueos: ${lista(v.data.bloqueos)}`)
    console.log(`  confirmaciones: ${lista(v.data.confirmaciones)}`)
    if (v.data.apta) {
      const e = leer<{ sha256: string }>(await oc.generar_evidencia.execute({ caso }, ctx))
      if (e.ok) console.log(`  evidencia sha256: ${e.data.sha256.slice(0, 16)}…`)
    }
    console.log(`  resultado: ${await intentarCrear(caso)}`)
  }

  console.log("\n=== 2. Idempotencia: sol-001 por segunda vez ===")
  console.log(`  ${await intentarCrear("sol-001")}`)

  console.log("\n=== 3. Confirmación explícita (confirmado = true) ===")
  console.log(`  sol-004 (diferencia cotización > 2 %): ${await intentarCrear("sol-004", true)}`)
  console.log(`  sol-005 (OC retroactiva):              ${await intentarCrear("sol-005", true)}`)
  console.log("  sol-006 queda pendiente de confirmación (IVA derivado) a propósito.")

  console.log("\n=== 4. Integridad: payload alterado (precio cambiado) ===")
  const alterado = await payloadDe("sol-006")
  if (alterado?.posiciones[0]) alterado.posiciones[0].precio_unitario = 1
  const r = leer<DatosCreacion>(await oc.crear.execute({ caso: "sol-006", payload: alterado, confirmado: true }, ctx))
  console.log(`  sol-006 con precio alterado: ${r.ok ? "OC creada (¡error!)" : `rechazada → ${r.error}`}`)

  console.log("\n=== 5. out/control.csv ===")
  console.log((await readFile(path.join(ctx.directory, "out", "control.csv"), "utf8")).trimEnd())
  console.log("")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e)
  process.exitCode = 1
})
