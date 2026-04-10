# Análisis de Costos y Unit Economics (MedAgent)

Este documento proyecta y desglosa los costos base de infraestructura, LLMs y herramientas terceras involucradas en mantener la operación de **un cliente (clínica)**, comparados directamente con nuestros planes de suscripción para calcular los márgenes de rentabilidad real (Gross Margin).

---

## 1. Costos Base de Proveedores 💸

| Concepto | Proveedor | Costo Estimado | Tipo |
| :--- | :--- | :--- | :--- |
| **Integración WhatsApp API** | Kapso | **$10.00 USD** / número | Fijo (Mensual)* |
| **Hosting Temporal / DB / Backend** | Railway | **~$5.00 USD** / cliente | Fijo (Mensual)** |
| **Consumo de IA (LLM Models)** | OpenAI / Anthropic | **$20.00 USD** por c/600 conv. | Variable |

> *El costo de Kapso es sobre el número base. Las ventanas de conversación de Meta pueden aplicar tarifas adicionales dependiendo de quién inicie, pero no se detallan en el costo crudo de infraestructura.*
> **El costo de Railway de $5 USD es un promedio de consumo en base de datos o procesamiento distribuido que gastaría un tenant pequeño/mediano.*

**Costo LLM Unitario:** Al dividir $20 entre 600 conversaciones, se promedia a **~$0.033 USD por conversación de IA**.

---

## 2. Análisis de Rentabilidad por Plan Comercial 🚀

Aquí cruzaremos nuestro costo contra nuestras tarifas comerciales públicas.

### 🥉 PLAN STARTER ($99 USD/mes)
*Incluye: 200 conversaciones.*
* **Costo Fijo (Kapso + Railway):** $15.00 USD
* **Costo Variable (LLM - 200 convs):** $6.66 USD
* **Costo Total por Cliente:** **$21.66 USD**
* **Beneficio Neto Bruto (MRR Libre):** **$77.34 USD**
* **Margen Bruto (Gross Margin):** **~78.1%**

### 🔥 PLAN GROWTH ($199 USD/mes) - *El Más Elegido*
*Incluye: 600 conversaciones.*
* **Costo Fijo (Kapso + Railway):** $15.00 USD
* **Costo Variable (LLM - 600 convs):** $20.00 USD
* **Costo Total por Cliente:** **$35.00 USD**
* **Beneficio Neto Bruto (MRR Libre):** **$164.00 USD**
* **Margen Bruto (Gross Margin):** **~82.4%**

### 💎 PLAN ENTERPRISE ($399 USD/mes)
*Incluye: > 1,500 conversaciones.*
* **Costo Fijo (Kapso + Railway):** $15.00 USD *(Puede aumentar si se despliega en BD dedicadas)*
* **Costo Variable (LLM - 1500 convs):** $50.00 USD
* **Costo Total por Cliente:** **$65.00 USD**
* **Beneficio Neto Bruto (MRR Libre):** **$334.00 USD**
* **Margen Bruto (Gross Margin):** **~83.7%**

---

## 3. Economía del Overage (Excesos de uso) 📈

Cuando un cliente supera su bolsa de conversaciones, se cobra un *overage*. Es importante analizar qué tan rentable es cruzar la barrera artificial que les ponemos:

* **Nuestro costo real por conv. extra:** **$0.033 USD**
* **Overage Plan Starter (Cobrado a $0.20):** Beneficio de +$0.166 USD por conv. (**Margen del 83.5%**)
* **Overage Plan Growth (Cobrado a $0.15):** Beneficio de +$0.117 USD por conv. (**Margen del 78%**)

> **Ejemplo real:** Si un cliente Growth tiene 800 conversaciones (200 de overage), él paga `$199 + (200 * $0.15) = $229`. El costo para nosotros será `$15 fijo + ($0.033 * 800) = $41.4`. La ganancia se estira a `$187.6 USD`.

---

## Resumen del Proyecto

Los *Unit Economics* del modelo comercial de MedAgent son **EXCELENTES**. Mantener los márgenes de software moderno por encima del 80% (Gross Margin SaaS estándar del mercado) es completamente viable desde el plan Starter en adelante. 

El cuello de botella financiero no estará en el uso del LLM, sino en escalar las ventas y contener el coste de adquisición de cliente (CAC), ya que la tecnología rinde financieramente por sí misma desde el día 1.
