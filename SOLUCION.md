# SOLUCIÓN — Reto 03: Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano cada orden de compra en SAP y verifica de memoria que proveedor, aprobador, tope y centro de costo sean válidos. Eso cuesta tiempo, deja pasar errores que se corrigen en el cierre contable y no permite medir cuántas OC se crean después de la factura. Le duele a la analista (tiempo), a contabilidad y auditoría (control) y a la dirección (no puede medir el desvío).

## 2. Arquitectura

```
┌──────────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│  Front (web/)        │ ────────────────▶ │  Backend (src/server.ts, node:http)          │
│  - historial         │ ◀──────────────── │  ┌────────────────────────────────────────┐  │
│  - tarjeta por cada  │  reply, toolCalls, │  │ Ciclo del agente (src/agent/ciclo.ts)  │  │
│    llamada a tool    │  needsConfirmation │  │ prompt → modelo → tools → modelo …     │  │
│  - banda de          │                    │  │ tope de iteraciones · tope de tokens   │  │
│    confirmación      │                    │  │ puerta de confirmación humana (CA3)    │  │
└──────────────────────┘                    │  └───────┬──────────────────────┬─────────┘  │
                                            │          │                      │            │
                                            │  Adaptador LLM          Registro de tools    │
                                            │  (src/llm/)             (zod → JSON Schema)  │
                                            │  interfaz + Anthropic           │            │
                                            └──────────────────────────────── │ ───────────┘
                                                                              ▼
                             src/tools/oc.ts  →  src/oc/ (lectura, reglas, payload, evidencia)
                                     │                         │
                          fixtures/ (solo lectura)     src/sap/mock.ts → out/ (escritura)
```

**Dónde vive cada cosa** (separación evaluada):

| Capa | Archivo | Cambia cuando… |
|---|---|---|
| Comportamiento | `agent/prompt.md` | cambia cómo debe conversar y en qué orden usar las herramientas |
| Conocimiento | `src/knowledge/ordenes-compra.md` | cambia la explicación del proceso o el glosario |
| Ejecución | `src/tools/oc.ts` + `src/oc/` | cambia una regla de negocio (por ejemplo, la tolerancia de RC5 en `PARAMETROS`) |

Cambiar una regla no toca el servidor. El servidor carga el prompt y el conocimiento desde archivos al arrancar.

## 3. Ciclo del agente

Implementado en `src/agent/ciclo.ts`, sin frameworks:

1. Llega el mensaje del usuario. Se agrega a la sesión, que vive en memoria.
2. Se envían al modelo el prompt de sistema (prompt + conocimiento), el historial y las herramientas. Los esquemas de las herramientas se generan desde zod.
3. Si el modelo pide herramientas, el backend valida los argumentos con zod, las ejecuta y devuelve el resultado como `tool_result`. Cada llamada queda en el historial visible y en `out/log.jsonl` (CA4).
4. Se repite hasta que el modelo responde sin pedir herramientas, o hasta llegar a `MAX_ITERACIONES` (25 por defecto). Si se alcanza el tope, se responde con lo hecho y lo que falta (CA1).
5. Un error del modelo (timeout, 4xx o 5xx) se muestra en el chat en lenguaje claro y la sesión sigue viva (CA5).

**Confirmación humana (CA3), aplicada en código y no solo en el prompt:**

- Cuando `oc_validar` devuelve confirmaciones, o `oc_crear` responde `requiere_confirmacion`, la sesión marca un **pendiente** para ese caso y ese turno. El turno termina con `needsConfirmation = true` y el front muestra la banda de confirmación.
- `confirmado = true` en `oc_crear` **solo se respeta** si se cumplen tres condiciones: el pendiente es del mismo caso, se pidió en un **turno anterior** y el mensaje actual del usuario es afirmativo ("confirmo", "sí, créala"…). Si falta alguna, el backend lo convierte en `false` y la herramienta responde que requiere confirmación.
- Resultado: aunque el modelo se equivoque o un documento intente manipularlo, la OC no se crea sin un "sí" del humano en un mensaje posterior. `npm run prueba:ciclo` lo demuestra con un modelo guionizado que intenta saltarse la confirmación.

**Control de costo:** tope de iteraciones por turno, tope de tokens por sesión (`MAX_TOKENS_SESION`), timeout por llamada y, opcionalmente, una clave de acceso al link (`APP_ACCESS_KEY`). El texto completo de la cotización no se reenvía al modelo.

## 4. Elección del modelo

- **Proveedor:** Anthropic. **Modelo:** `claude-sonnet-5-5`, configurable con `LLM_MODELO`.
- **Por qué:** el reto exige encadenar varias herramientas en orden, respetar reglas estrictas ("no afirmes valores que no vengan de una herramienta") y presentar el resultado en tablas en español. Para eso pesa más la confiabilidad en el uso de herramientas que el costo por token. Como el adaptador es intercambiable (`src/llm/adapter.ts`), se puede probar un modelo más económico cambiando una variable de entorno.
- **Costo estimado por caso procesado: el gasto total en la consola del proveedor durante todo el desarrollo y las pruebas del mes (simulacro previo, pruebas locales del chat y pruebas del link desplegado) fue de **USD 0,48**. Es un gasto agregado, no un costo por caso.
- **Costo por caso: método de medición.** Cada sesión del chat muestra sus tokens de entrada y de salida (en la cabecera del chat y en `GET /api/sessions/:id`). Para un caso aislado se abre una sesión nueva, se procesa ese caso y se aplica la tarifa vigente del modelo:
  `costo por caso = (tokens de entrada × tarifa de entrada + tokens de salida × tarifa de salida) / 1.000.000`
- **Qué determina el costo:** cada turno reenvía al modelo el historial completo de la sesión, así que el costo crece con la longitud de la conversación. Por eso se recomienda una sesión por caso. Las palancas de control son `MAX_TOKENS_SESION`, `MAX_ITERACIONES` y la elección de modelo (`LLM_MODELO`).
- **Tope de gasto real:** el saldo prepagado de la cuenta del proveedor actúa como límite duro; además, la aplicación corta cada sesión al llegar a `MAX_TOKENS_SESION`.
  1. Procesar cada caso en el chat y leer los tokens de entrada y salida de la sesión. Aparecen en la cabecera del chat y en `GET /api/sessions/:id`.
  2. Aplicar la tarifa vigente del modelo elegido, tomada de la consola del proveedor:
     `costo por caso = (tokens de entrada × tarifa de entrada + tokens de salida × tarifa de salida) / 1.000.000`

| Caso | Tokens de entrada | Tokens de salida | Costo |
|---|---|---|---|
| sol-001 | _medir_ | _medir_ | _calcular con la tarifa vigente_ |
| sol-004 (con confirmación) | _medir_ | _medir_ | _calcular con la tarifa vigente_ |

## 5. Matriz de controles

Todas las reglas son funciones puras en `src/oc/reglas.ts`. `oc_validar` evalúa **todas** (no se detiene en la primera) y consolida `{ apta, bloqueos, confirmaciones, derivados, retroactiva }`.

| Regla | Riesgo que mitiga | Implementación | Fuente | Si falla | Caso que la prueba |
|---|---|---|---|---|---|
| RC1 | Pagar a un proveedor no registrado o inactivo | Búsqueda por NIT normalizado (sin puntos ni dígito de verificación); sin NIT, por nombre sin tildes ni puntuación | `proveedores.json` | Bloqueo `PROVEEDOR_INEXISTENTE` / `PROVEEDOR_INACTIVO` | sol-002 |
| RC2 | Gasto aprobado por alguien sin autoridad | La aprobación existe, contiene "Aprobado" (no negado) y su remitente está entre los aprobadores del centro | `aprobacion.json`, `centros-costo.json` | Bloqueo `APROBADOR_NO_AUTORIZADO` y otros; sugiere a quién pedirla y si hay que escalar | sol-003 |
| RC3 | Aprobación por encima de la atribución | `valor_total ≤ tope` del aprobador en ese centro | `centros-costo.json` | Bloqueo `TOPE_EXCEDIDO` | — |
| RC4 | Imputación contable errada | El centro existe y la subárea le pertenece | `centros-costo.json` | Bloqueo `SUBAREA_INVALIDA` / `CENTRO_COSTO_INEXISTENTE` | — |
| RC5 | Pagar un valor distinto al cotizado | `abs(cotización − solicitud) / solicitud ≤ 2 %`; sin cotización, confirmación | `cotizacion.txt` | Confirmación `DIFERENCIA_COTIZACION` con ambos valores | sol-004 (6 %) |
| RC6 | IVA mal causado | Si falta, se deriva `indicador_iva_default` del proveedor | `proveedores.json` | Confirmación `IVA_DERIVADO` + derivado | sol-006 |
| RC7 | Condición de pago faltante | Si falta, se deriva del proveedor | `proveedores.json` | Derivado informado | sol-006 |
| RC8 | Compras hechas antes de la OC | Fecha de factura < fecha de solicitud → `retroactiva = true` | `factura.txt` | Confirmación `OC_RETROACTIVA` + marca en `control.csv` | sol-005 |
| RC9 | Aprobación que no corresponde a la solicitud | Fecha de aprobación ≥ fecha de solicitud | `aprobacion.json` | Confirmación `APROBACION_ANTERIOR` | — |
| RC10 | Errores de digitación en el Excel | `cantidad × valor_unitario = valor_total (± 1)` | `solicitud.json` | Bloqueo `TOTAL_INCONSISTENTE` | — |

**Controles adicionales de integridad** (no son reglas del PRD, sino del diseño):
- Las herramientas **releen las fuentes** por `caso`. No confían en el `paquete` ni en los `derivados` que envía el modelo.
- `oc_crear` reconstruye el payload desde las fuentes y lo compara con el recibido. Si el modelo alteró un valor, por ejemplo el precio, se rechaza con `PAYLOAD_ALTERADO`. `demo.ts` lo prueba en la sección 4.
- El nombre del caso se valida contra un patrón estricto, para evitar leer rutas fuera de `fixtures/` (path traversal).

**La regla más difícil: RC2 + RC3 en sol-003.** Felipe Vargas tiene un tope de 80 millones, suficiente para los 74 millones, pero es aprobador de **Comercial** (CC-3030), no de **Administración** (CC-2020), que es donde se imputa la compra. Un control ingenuo por tope dejaría pasar la OC. La decisión fue evaluar RC3 solo contra el tope del aprobador **en el centro imputado**. Si el aprobador no pertenece al centro, RC2 bloquea y RC3 no aplica. Además, el sistema calcula si **algún** aprobador válido del centro tiene tope suficiente. En sol-003 ninguno lo tiene (Rocío Torres, 30 millones), así que la acción sugerida es **escalar**, no solo "pedir otra firma".

## 6. Diseño del adaptador SAP real

La interfaz `SapAdapter` (`src/sap/adapter.ts`) no cambia. Se escribe `src/sap/odata.ts`, que la implementa, y se inyecta con `configurarSap()` en `src/tools/oc.ts`. Ni el agente ni las herramientas cambian.

**Opción de integración elegida:** OData `API_PURCHASEORDER_PROCESS_SRV` sobre S/4HANA, expuesto a través de **SAP Integration Suite** (o API Management).
- Es la API estándar y soportada de SAP para crear órdenes de compra; RFC/BAPI depende de librerías nativas y de acceso directo a la red del ERP.
- Integration Suite permite publicarla con seguridad, transformar el payload y monitorear sin abrir el ERP.
- Como la viabilidad no está confirmada, el primer paso es un **piloto en el ambiente de calidad (QAS)** con un solo proveedor y un solo centro. Si SAP es ECC sin OData, la alternativa es `BAPI_PO_CREATE1` vía RFC desde Integration Suite.

**Mapeo del payload (7.4 → OData):**

| Payload | Campo SAP |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (40 caracteres) |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` |
| `posiciones[].precio_unitario` | `NetPriceAmount` |
| `posiciones[].indicador_iva` | `TaxCode` |
| `posiciones[].centro_costo` | Imputación: `AccountAssignmentCategory = K` + `CostCenter` |
| `referencia.solicitud_id` | Campo de referencia externa (por ejemplo, `CorrespncExternalReference`) |
| Evidencia (`aprobacion.pdf`) | Adjunto vía API de adjuntos (Attachment Service) |

El mapeo exacto de campos (por ejemplo, el grupo de compras o el material) se valida con el equipo SAP en el piloto.

**Autenticación y credenciales:**
- Usuario técnico de comunicación con **mínimo privilegio**: solo crear y consultar OC, en las sociedades autorizadas.
- OAuth 2.0 client credentials o certificado X.509 contra Integration Suite.
- Las credenciales viven en un **gestor de secretos** (Azure Key Vault, AWS Secrets Manager o equivalente) y se inyectan al backend como variables de entorno. **Nunca** en el agente, el prompt, el repositorio ni los logs.
- Conectividad privada hacia el ERP (VPN site-to-site, enlace dedicado o SAP Cloud Connector), sin exponer SAP a internet.

**Idempotencia y errores parciales:**
- Antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta la referencia externa. Si existe, se devuelve el número.
- Reintentos con backoff exponencial **solo** ante errores transitorios (timeout, 503). Antes de cada reintento se vuelve a consultar por referencia, para no duplicar una OC que sí se creó pero cuya respuesta se perdió.
- Error de negocio (400 con mensajes de SAP: proveedor bloqueado en SAP, período cerrado): no se reintenta. Se devuelve al humano con el mensaje de SAP traducido.
- Error parcial (OC creada, adjunto fallido): se registra en `control.csv` como `exitoso` con la excepción `ADJUNTO_PENDIENTE` y se reintenta solo el adjunto.

**Plan B si la conexión no es viable:** el agente igual elimina la digitación y conserva los controles.
1. **Ficha lista para pegar:** la OC validada en el formato y orden de los campos de la transacción ME21N.
2. **Archivo de carga masiva** (CSV/Excel) con el formato de la herramienta de carga que use el equipo SAP (por ejemplo, LSMW o la app de migración de S/4HANA), generado desde `out/sap/ordenes.jsonl`.
3. La analista crea la OC y registra el número real. `control.csv` sigue midiendo retroactivas y bloqueos.

## 7. Lectura del proceso: las OC retroactivas

*Mensaje a la dirección:*

Una OC retroactiva no es un problema de digitación: es un **control que no existió**. La OC debería autorizar el gasto antes de comprometerlo. Cuando se crea después de la factura, el compromiso ya ocurrió, la cotización se saltó y la aprobación del líder pasa a ser una formalidad para poder pagar. En sol-005 el propio aprobador lo dice: *"Ya llegó la factura, por favor crear la OC para poder radicarla."*

Los riesgos concretos son tres:
- **Presupuesto:** el gasto se compromete sin verificar disponibilidad.
- **Negociación:** sin cotización previa no hay comparación de precios.
- **Fraude y segregación de funciones:** quien compra también define el proveedor y el precio sin un control independiente.

Es, además, un hallazgo típico de auditoría.

**El agente no bloquea las retroactivas**, porque el bien o servicio ya se recibió y hay que pagarlo. Bloquearlas solo empujaría el proceso a la informalidad. Lo que hace es **ponerles fricción y medirlas**: exige confirmación explícita y las marca `retroactiva = true` en `control.csv`.

**Cambio de proceso propuesto:**
1. **Medir antes de decidir:** durante 4 a 8 semanas, publicar el porcentaje de OC retroactivas por centro de costo, área y proveedor, calculado desde `control.csv`.
2. **Atacar la causa raíz donde se concentre:** compras recurrentes (papelería, licencias) → **OC abiertas o contratos marco** con consumo contra la OC; urgencias reales → un **procedimiento de compra urgente** con aprobación posterior en un plazo máximo.
3. **Política escalonada:** tolerar con marca por debajo de un umbral y exigir la aprobación de un nivel superior por encima. La decisión de tolerar o rechazar es de la dirección (pregunta abierta del PRD); el agente aporta el dato.
4. **Indicador de seguimiento:** el porcentaje de OC retroactivas por área, revisado en el comité mensual.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas releen las fuentes por `caso` y verifican el payload recibido | Confiar en el `paquete`, los `derivados` y el `payload` que envía el modelo | Es el riesgo del PRD: el modelo podría "arreglar" un monto. Así el modelo no puede alterar un valor validado. El costo es una relectura de archivos pequeños por llamada. |
| La confirmación humana se aplica en el backend (puerta en el ciclo) | Confiar solo en la instrucción del prompt | Un prompt se puede incumplir o manipular, por ejemplo con texto inyectado en una cotización. El código no. |
| `node:http` + `fetch` nativo, sin framework ni SDK | Express/Fastify y el SDK oficial del proveedor | Menos dependencias, el mismo código corre en Node y Bun, y el ciclo queda explícito y explicable línea por línea. El costo: rutas y parseo escritos a mano. |
| `oc_crear` siempre es la "puerta" final: también se llama ante bloqueos para registrar el intento | Registrar el control dentro de `oc_validar` | `control.csv` mide **intentos de creación**, como pide HU-5. Validar no es intentar crear. |
| Ante RC5, la OC se crea por el valor de la **solicitud** | Crear por el valor de la cotización | El valor de la solicitud es el que aprobó el líder ("Aprobado por 25 millones"). Crear por la cotización excedería lo aprobado. La diferencia queda en `excepciones`. |
| Sesiones en memoria | Persistirlas en archivo | No-objetivo del PRD. Si el servidor se reinicia se pierden las conversaciones, pero las OC, los logs y el control quedan en `out/`. |

## 9. Supuestos

1. Los precios unitarios y totales de solicitud y cotización **incluyen IVA**, como dicen las cotizaciones. RC5 compara totales con IVA.
2. El NIT se compara sin puntos y sin dígito de verificación (`900.555.111-2` → `900555111`).
3. "Contener Aprobado" significa la palabra "aprobado/aprobada" **no precedida de "no"**.
4. RC9 compara la fecha local que trae el correo (los primeros 10 caracteres de la fecha ISO), sin convertir zona horaria.
5. Si el aprobador no pertenece al centro (RC2), RC3 no aplica. Se informa si algún aprobador válido tendría tope suficiente.
6. Unidad SAP: "hora(s)" en la descripción → `H`; "mensual" o "por mes" → `MES`; en otro caso → `UN`. Es una regla simple y queda trazada como "derivado".
7. La descripción se trunca a 40 caracteres (límite del texto breve en SAP).
8. Una segunda creación de la misma solicitud se registra en `control.csv` como `existente`, para no contar dos veces la misma OC al medir retroactivas.
9. `sol-001` se crea sin intervención humana (O1) cuando el usuario pide procesarla, porque no tiene excepciones. Si el usuario pide expresamente no crearla, el agente pregunta.
10. `confirmado_por` registra la sesión del chat que confirmó, porque no hay autenticación de usuarios (no-objetivo).

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx`, `.pdf` y `.eml` reales (P1 opcional, no hecho) |
| HU-2 Validar contra maestros | Hecho (RC1–RC10) | Maestros consultados en SAP en tiempo real |
| HU-3 Construir payload con zod y trazabilidad | Hecho | Validar el mapeo de campos con el equipo SAP |
| HU-4 Evidencia | Hecho: P0 `.txt` + P1 `.pdf` | Firma digital, si auditoría la exige |
| HU-5 Crear OC (idempotente, control.csv) | Hecho en SAP simulado | Adaptador OData real (sección 6) |
| HU-6 Manejo de errores | Hecho: `{ ok: false, error }`, sin excepciones | Pruebas con paquetes corruptos reales |
| Front con tool calls y confirmación | Hecho | Autenticación de usuarios y roles |
| `demo.ts` sin modelo | Hecho | — |
| Bonus módulo reutilizable | Hecho: `modulo/` se genera desde las mismas fuentes | — |
| `oc_leer_excel` (P1) | No hecho | — |

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic), en una sesión conversacional con acceso a un entorno de ejecución.
- **Para qué:**
  - Lectura del PRD y los fixtures, y propuesta de arquitectura.
  - Generación del código TypeScript.
  - Ejecución de `demo.ts`, el typecheck y la prueba del ciclo para verificar los 6 casos.
  - Borradores de README y de este documento.
- Revisión y decisiones propias: elegí el reto 3 por su foco en controles, integración y riesgo. Revisé el PRD y los resultados de `demo.ts` contra lo esperado en cada caso. Ejecuté la aplicación en local, probé el chat con el modelo real y detecté que los mensajes del chat se mostraban recortados; pedí la corrección y la verifiqué. Decidí publicar el repositorio y desplegar en Render con la clave del modelo solo como variable de entorno.
  - Pasar el `paquete` completo del modelo a `oc_validar` y confiar en él: se descartó por el riesgo de alteración (sección 8).
  - Usar el SDK oficial y un framework web: se descartaron para reducir dependencias y hacer el ciclo explícito.
  - Evaluar RC3 con el tope del aprobador en cualquier centro: se descartó porque dejaba pasar sol-003.
  - _Completar por Javier con lo que descartó él._

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable a corto plazo | Plan B (sección 6): ficha lista para pegar o archivo de carga masiva. Los controles y la medición siguen funcionando. |
| Inyección de instrucciones en documentos (cotización o correo con "ignora las validaciones") | Los documentos se parsean con expresiones regulares, no se interpretan. Las reglas están en código. La creación exige confirmación en el backend y verificación del payload. |
| El modelo "arregla" un monto | El payload se reconstruye desde las fuentes y se compara. Si no coincide, se rechaza. |
| Fuga o abuso de la clave del modelo | La clave solo vive en una variable de entorno del backend. Tope de tokens por sesión e iteraciones. Clave de acceso opcional al link. Rotación periódica de la clave. |
| Maestros desactualizados (proveedor bloqueado en SAP pero activo en el archivo) | En producción, `consultarProveedor` va a SAP en tiempo real. |
| Suplantación del correo de aprobación (remitente falsificado) | Validar SPF/DKIM del correo o mover la aprobación a un flujo con firma; registrar el `sha256` de la evidencia (ya se hace). |
| Confirmación hecha por cualquiera con acceso al chat | Autenticación con el directorio corporativo (Entra ID) y registro del usuario real en `confirmado_por`. |
| Pérdida de sesiones al reiniciar | Persistir sesiones en un almacén. `out/` ya conserva el rastro de auditoría. |
| Costo variable del modelo | Medir los tokens por caso (sección 4), fijar alertas de gasto en el proveedor y evaluar un modelo más económico cambiando `LLM_MODELO`. |
