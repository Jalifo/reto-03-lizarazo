---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — reglas de control RC1–RC10, glosario (OC retroactiva, indicadores de IVA, condiciones de pago) y qué devolver al humano en cada excepción.
---

# Conocimiento del proceso: órdenes de compra en Periferia

## El proceso

Cada compra llega a administración por correo con tres piezas: la solicitud (Excel), la cotización del proveedor y el correo de aprobación del líder. La analista crea la OC en SAP con proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta la aprobación como evidencia en PDF.

## Reglas de control

| Regla | Qué verifica | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y la envió un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | La cotización no difiere más de 2 % de la solicitud. Sin cotización, se confirma. | Confirmación |
| RC6 | Sin indicador de IVA, se propone el del proveedor y se confirma. | Confirmación + derivado |
| RC7 | Sin condiciones de pago, se toman las del proveedor. Solo se informa. | Derivado |
| RC8 | Factura anterior a la solicitud: OC retroactiva. Se confirma y se registra. | Confirmación |
| RC9 | La aprobación no puede ser anterior a la solicitud. Si lo es, se confirma. | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1). | Bloqueo |

- **Bloqueo**: la OC no se crea. Se devuelve al solicitante con la acción sugerida.
- **Confirmación**: la OC se crea solo si la analista confirma explícitamente en un mensaje posterior.
- **Derivado**: valor completado desde los maestros; siempre se informa.

## Glosario

- **OC retroactiva**: la compra se hizo (llegó la factura) antes de que existiera la orden de compra. Es un desvío de proceso: se salta el control previo del gasto y la cotización. La dirección quiere medir cuántas hay.
- **Indicador de IVA**: C0 excluido, C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015 15 días, Z030 30 días, Z060 60 días.
- **Valores de la cotización**: los precios unitarios de las cotizaciones incluyen IVA.
- **Idempotencia**: procesar dos veces la misma solicitud devuelve la OC existente; nunca crea una segunda.

## Qué devolver al humano

- Proveedor inexistente o inactivo: pedir su creación o reactivación en SAP, o cambiar de proveedor.
- Aprobador sin autoridad: pedir la aprobación a un aprobador válido del centro de costo, con tope suficiente; si ninguno lo tiene, escalar.
- Diferencia con la cotización: confirmar por el valor aprobado o devolver para actualizar solicitud y aprobación.
