# 📊 Análisis de Costos y Rentabilidad (Commercial)

Este documento proyecta los márgenes brutos operacionales (Gross Margin) del proyecto MedAgent, cruzando los modelos de precios publicados (Landing Page) con los costos base de infraestructura.

## 1. Unit Economics (Costos Base)

Conforme al análisis de consumo actual operativo de la plataforma:
- **Modelo de Lenguaje (LLM):** ~$20 USD por cada 60 conversaciones.
  - *Costo Unitario:* **$0.333 USD por conversación**.
- **Infraestructura (Railway):** **$5 USD** aproximado por cliente o instancia/mensual.
- **Línea WhatsApp API (Kapso):** **$10 USD** por número nuevo / cliente (fijo mensual).

---

## 2. Análisis por Plan de Venta

Actualmente en la landing comercial (Vercel) tenemos dos planes estandarizados que analizaremos a continuación:

### ⚠️ Plan "Starter" ($99 USD / mes)
Ofrece: 200 conversaciones mensuales.

**Proyección de Costos Directos:**
* **Costo LLM (200 conv.):** 200 x $0.333 = $66.66 USD
* **Línea Kapso:** $10.00 USD
* **Servidor Railway:** $5.00 USD
* **Costo Directo Total:** **$81.66 USD**

**Margen Bruto (Gross Profit):**
* Venta ($99) - Costo ($81.66) = **+$17.34 USD** 
* *Margen Operativo:* **17.5%** (Es un margen bajo para SaaS, sin considerar comisiones de pasarela de pago como Stripe/MercadoPago, ni soporte o adquisición de cliente - CAC).

**Overage (Costo Extra):**
* El cliente paga: $0.20 USD por conversa.
* Costo real LLM: $0.33 USD por conversa.
* **Pérdida en Overage:** -$0.13 USD por cada conversación de sobregiro.


### 🚨 Plan "Growth" ($199 USD / mes)
Ofrece: 600 conversaciones mensuales.

**Proyección de Costos Directos:**
* **Costo LLM (600 conv.):** 600 x $0.333 = $200.00 USD
* **Línea Kapso:** $10.00 USD
* **Servidor Railway:** $5.00 USD
* **Costo Directo Total:** **$215.00 USD**

**Margen Bruto (Gross Profit):**
* Venta ($199) - Costo ($215.00) = **-$16.00 USD (Rentabilidad Negativa).**
* *Margen Operativo:* **-8%** (Se está subsidiando el uso al costo actual).

**Overage (Costo Extra):**
* El cliente paga: $0.15 USD por conversa.
* Costo real LLM: $0.33 USD por conversa.
* **Pérdida en Overage:** -$0.18 USD por cada conversación de sobregiro.

---

## 3. Conclusiones y Recomendaciones de Urgencia

Al cruzar la tabla de costos que has proporcionado, nos enfrentamos a un problema de rentabilidad ("Negative Unit Economics") si los clientes agotan su cuota de conversaciones contenidas en el plan, especialmente en el tier **Growth**.

### Posibles vías de mitigación:
1. **Reducir el Costo de LLM:**
   - ¿Estamos mandando historiales inmensos al modelo en cada interacción? Limitar el historial de chat (Truncate) a los últimos 5-10 mensajes.
   - ¿Qué LLM se usa? Considerar usar modelos menos costosos pero altamente capaces para flujos simples (como *Claude 3 Haiku*, o *Gemini 1.5 Flash* - *Ojo, tenemos prohibido usar Flash en este proyecto globalmente*). Como Flash está prohibido por las reglas *[user_global]*, quizá debamos evaluar optimizar los prompts fuertemente con los modelos aceptados.
2. **Ajustar Precios o Límites Promesados:**
   - Reducir agresivamente las conversaciones incluidas (Ej. Starter a 100 convs., Growth a 300 convs.).
   - Disminuir la definición de "Conversación" a sesiones de 24 horas y aumentar sustancialmente los precios del plan, o cobrar el "Overage" mínimo a **$0.40 USD**.
3. **Upsells:** 
   - Que el plan cubra poco (el "Cebo") pero los servicios de setup inicial cubran la cuota inicial (aunque el landing dice "Setup Bonificado, 100% gratis").

*Revisión recomendada con el equipo de infraestructura para ver cómo reducir costos de token antes del onboarding masivo.*
