// Configuración desde variables de entorno y carga del prompt + conocimiento desde archivos.
import { readFileSync } from "node:fs"
import path from "node:path"
import { AdaptadorAnthropic } from "../llm/anthropic"
import type { AdaptadorLlm } from "../llm/adapter"

// Node 20.12+ trae process.loadEnvFile; Bun carga .env por sí solo. Si no hay .env, se sigue sin error.
const cargarEnv = (process as { loadEnvFile?: (ruta?: string) => void }).loadEnvFile
try {
  cargarEnv?.(".env")
} catch {
  // sin archivo .env: se usan las variables del entorno
}

function numero(nombre: string, porDefecto: number): number {
  const v = Number(process.env[nombre])
  return Number.isFinite(v) && v > 0 ? v : porDefecto
}

export const CONFIG = {
  directorio: process.cwd(),
  puerto: numero("PORT", 3000),
  maxIteraciones: numero("MAX_ITERACIONES", 25),
  maxTokensSesion: numero("MAX_TOKENS_SESION", 300000),
  timeoutMs: numero("LLM_TIMEOUT_MS", 60000),
  claveAcceso: process.env.APP_ACCESS_KEY?.trim() || null,
  proveedor: process.env.LLM_PROVEEDOR?.trim() || "anthropic",
  modelo: process.env.LLM_MODELO?.trim() || "claude-sonnet-5-5",
} as const

/** Separación evaluada: comportamiento (agent/prompt.md) + conocimiento (src/knowledge/). */
export function cargarPromptSistema(directorio: string): string {
  const prompt = readFileSync(path.join(directorio, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(path.join(directorio, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return `${prompt}\n\n---\n\n${conocimiento}`
}

export function crearAdaptador(): AdaptadorLlm | null {
  if (CONFIG.proveedor === "anthropic") {
    const clave = process.env.ANTHROPIC_API_KEY?.trim()
    return clave ? new AdaptadorAnthropic(clave, CONFIG.modelo, CONFIG.timeoutMs) : null
  }
  return null
}
