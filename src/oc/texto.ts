// Utilidades puras de normalización. Sin efectos secundarios: fáciles de probar y de explicar.

/** "COP 11.400.000" o "11.400.000,50" (formato colombiano) → 11400000 / 11400000.5 */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (limpio === "") return null
  const sinMiles = limpio.replace(/\./g, "").replace(",", ".")
  const valor = Number(sinMiles)
  return Number.isFinite(valor) ? valor : null
}

/** "900.555.111-2" → "900555111" (quita puntos y dígito de verificación). */
export function normalizarNit(nit: string): string {
  const sinDv = nit.split("-")[0] ?? nit
  return sinDv.replace(/\D/g, "")
}

/** "Papelería Central Ltda." → "papeleriacentralltda" (sin tildes, mayúsculas ni puntuación). */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** "2026-08-21T10:02:00-05:00" → "2026-08-21" (fecha local tal como viene en el documento). */
export function soloFecha(fecha: string): string {
  return fecha.slice(0, 10)
}

/** Suma días a una fecha AAAA-MM-DD sin depender de la zona horaria del servidor. */
export function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split("-").map(Number)
  const base = new Date(Date.UTC(a ?? 0, (m ?? 1) - 1, d ?? 1))
  base.setUTCDate(base.getUTCDate() + dias)
  return base.toISOString().slice(0, 10)
}

/** Busca "Etiqueta: valor" en un texto y devuelve el valor de la primera línea que coincida. */
export function campo(texto: string, etiqueta: RegExp): string | null {
  for (const linea of texto.split(/\r?\n/)) {
    const m = linea.match(etiqueta)
    if (m?.[1] !== undefined) return m[1].trim()
  }
  return null
}

export function formatoCop(valor: number): string {
  return "$" + Math.round(valor).toLocaleString("es-CO")
}
