// Front del chat: historial, llamadas a herramientas visibles y resaltado de confirmación (PRD 6.1).
// No guarda ni conoce la clave del modelo: solo habla con /api del backend.
const $ = (id) => document.getElementById(id)
const chat = $("chat")
const entrada = $("entrada")
let sessionId = null
let claveAcceso = null

function leerAlmacen(clave) {
  try { return sessionStorage.getItem(clave) } catch { return null }
}
function guardarAlmacen(clave, valor) {
  try { sessionStorage.setItem(clave, valor) } catch { /* sin almacenamiento: se sigue en memoria */ }
}

// ---------- Markdown mínimo y seguro (se escapa todo antes de dar formato) ----------
function escapar(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
function enLinea(t) {
  return escapar(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}
function markdown(texto) {
  const lineas = texto.split("\n")
  let html = ""
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(lineas[i++])
      const celdas = (f) => f.trim().slice(1, -1).split("|").map((c) => c.trim())
      const cuerpo = filas.filter((f) => !/^\s*\|[\s:|-]+\|\s*$/.test(f))
      html += "<table>" + cuerpo.map((f, n) => {
        const tag = n === 0 ? "th" : "td"
        return "<tr>" + celdas(f).map((c) => `<${tag}>${enLinea(c)}</${tag}>`).join("") + "</tr>"
      }).join("") + "</table>"
      continue
    }
    if (/^\s*[-*]\s+/.test(l)) {
      html += "<ul>"
      while (i < lineas.length && /^\s*[-*]\s+/.test(lineas[i])) html += `<li>${enLinea(lineas[i++].replace(/^\s*[-*]\s+/, ""))}</li>`
      html += "</ul>"
      continue
    }
    const titulo = l.match(/^(#{1,4})\s+(.*)$/)
    if (titulo) html += `<p><strong>${enLinea(titulo[2])}</strong></p>`
    else if (l.trim()) html += `<p>${enLinea(l)}</p>`
    i++
  }
  return html
}

// ---------- Pintado ----------
function agregar(nodo) {
  chat.querySelector(".bienvenida")?.remove()
  chat.appendChild(nodo)
  chat.scrollTop = chat.scrollHeight
  return nodo
}
function mensaje(clase, contenidoHtml) {
  const div = document.createElement("div")
  div.className = `mensaje ${clase}`
  div.innerHTML = contenidoHtml
  return agregar(div)
}
function herramienta(ll) {
  const d = document.createElement("details")
  d.className = "herramienta"
  const estado = ll.ok ? '<span class="ok">✔</span>' : '<span class="falla">✖</span>'
  let resultado = ll.resultado
  try { resultado = JSON.stringify(JSON.parse(ll.resultado), null, 2) } catch { /* texto plano */ }
  d.innerHTML =
    `<summary>🔧 <span class="nombre">${escapar(ll.nombre)}</span> ${estado} <span>${escapar(ll.resumen)}</span> <span class="chip">${ll.ms} ms</span></summary>` +
    `<h4>Argumentos</h4><pre>${escapar(JSON.stringify(ll.argumentos, null, 2))}</pre>` +
    `<h4>Resultado</h4><pre>${escapar(resultado)}</pre>`
  agregar(d)
}
function mostrarConfirmacion(activa) {
  $("confirmacion").hidden = !activa
}

// ---------- API ----------
async function api(ruta, opciones = {}) {
  const headers = { "content-type": "application/json" }
  if (claveAcceso) headers["x-access-key"] = claveAcceso
  const r = await fetch(ruta, { ...opciones, headers })
  if (r.status === 401) {
    claveAcceso = prompt("Este enlace está protegido. Escribe la clave de acceso:") || null
    if (claveAcceso) guardarAlmacen("claveAcceso", claveAcceso)
    throw new Error("Clave de acceso requerida o inválida. Intenta de nuevo.")
  }
  return r.json()
}

async function enviar(texto) {
  if (!texto.trim()) return
  mensaje("usuario", escapar(texto))
  mostrarConfirmacion(false)
  const pensando = mensaje("pensando", "Pensando…")
  $("enviar").disabled = true
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
    pensando.remove()
    if (r.ok === false) return mensaje("error", escapar(r.error))
    sessionId = r.sessionId
    r.toolCalls.forEach(herramienta)
    mensaje(r.needsConfirmation ? "pide" : "", markdown(r.reply))
    mostrarConfirmacion(r.needsConfirmation)
    $("tokens").textContent = `${(r.tokens.entrada + r.tokens.salida).toLocaleString("es-CO")} tokens`
  } catch (e) {
    pensando.remove()
    mensaje("error", escapar(e.message || "Error de red"))
  } finally {
    $("enviar").disabled = false
    entrada.focus()
  }
}

// ---------- Eventos ----------
$("formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  const t = entrada.value
  entrada.value = ""
  enviar(t)
})
entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    $("formulario").requestSubmit()
  }
})
document.querySelectorAll(".sugerencia").forEach((b) => b.addEventListener("click", () => enviar(b.textContent)))
$("confirmar").addEventListener("click", () => enviar("Confirmo la creación de la OC."))
$("rechazar").addEventListener("click", () => enviar("No confirmo. No crees la OC."))
$("nueva").addEventListener("click", () => location.reload())

claveAcceso = leerAlmacen("claveAcceso")
api("/api/health")
  .then((h) => { $("modelo").textContent = h.model ? `${h.provider} · ${h.model}` : "modelo sin configurar" })
  .catch(() => { $("modelo").textContent = "sin conexión" })
