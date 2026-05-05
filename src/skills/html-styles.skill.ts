// =============================================================================
// HTML Styles Skill — Guía de diseño para la tool sendHtmlDocument
//
// Esta skill se inyecta en el system prompt cuando el agente tiene la tool
// `sendHtmlDocument` registrada. NO es toggleable por el admin: si la tool
// está, la skill está. La idea es que el LLM produzca HTML mínimamente bonito
// y consistente con la marca de la clínica, sin tener que improvisar markup.
//
// Forma de uso desde AiService:
//   import { buildHtmlStylesSkill } from '../skills/html-styles.skill';
//   const skillBlock = buildHtmlStylesSkill({ companyName, brandColors, logoUrl });
//   systemPrompt += `\n\n${skillBlock}`;
// =============================================================================

export interface BrandColors {
    /** Color principal (botones, headers, énfasis). Hex o nombre CSS. */
    primary?: string;
    /** Color secundario / acento. */
    accent?: string;
    /** Color de texto sobre fondos claros. */
    text?: string;
    /** Color de fondo de la página. */
    bg?: string;
}

export interface HtmlStylesContext {
    companyName: string;
    /** Si la company no tiene branding configurado, se usan defaults sobrios. */
    brandColors?: BrandColors | null;
    /** URL pública del logo (https). Si falta, no se renderiza header con logo. */
    logoUrl?: string | null;
}

const DEFAULT_COLORS: Required<BrandColors> = {
    primary: '#2C3E50',
    accent:  '#E67E22',
    text:    '#2C3E50',
    bg:      '#F8F9FA',
};

/**
 * Genera el bloque de skill que se inyecta en el system prompt.
 * El bloque indica paleta, tipografía, layout móvil y templates mínimos.
 */
export function buildHtmlStylesSkill(ctx: HtmlStylesContext): string {
    const colors = { ...DEFAULT_COLORS, ...(ctx.brandColors ?? {}) };
    const logoLine = ctx.logoUrl
        ? `Logo de la clínica disponible en: ${ctx.logoUrl} — úsalo como <img src="..."> en el header (max-width: 120px, height: auto).`
        : 'No hay logo configurado: el header debe usar el nombre de la clínica como texto destacado, sin <img>.';

    return `
HABILIDAD: COMPOSICIÓN DE HTML PARA WHATSAPP (sendHtmlDocument)

Cuándo usar la tool:
- Resúmenes de cita (fecha + tratamiento + dirección + preparación).
- Confirmaciones formales que el paciente quiera guardar/imprimir.
- Reportes operativos al staff (citas del día, métricas).
- Propuestas comerciales (Bruno) o resúmenes de onboarding.
NO la uses para mensajes conversacionales cortos: para eso el texto plano es mejor.

Reglas obligatorias del HTML:
1. Documento completo y autocontenido: <!DOCTYPE html>, <html lang="es">, <head> con <meta charset="utf-8"> y <meta name="viewport" content="width=device-width, initial-scale=1">, y <body>.
2. Estilos SIEMPRE inline o dentro de un solo <style> en <head>. Sin CSS externo, sin <link rel="stylesheet">, sin fuentes de Google Fonts ni dependencias remotas.
3. Sin <script>, <iframe>, ni handlers on*= (onclick, onload, etc.). Si los pones, el sanitizer los quita y el HTML llegará incompleto.
4. Mobile-first: ancho máximo del contenido 480px, padding generoso, font-size base 16px.
5. Colores: usa exclusivamente la paleta de la clínica (abajo). No inventes otros colores aunque parezcan "más bonitos".

Paleta de "${ctx.companyName}":
- Primary (header, botones, énfasis): ${colors.primary}
- Accent (íconos, detalles, CTAs secundarios): ${colors.accent}
- Texto: ${colors.text}
- Fondo: ${colors.bg}

Header:
- ${logoLine}
- El nombre de la clínica va siempre como <h1> con color primary, font-size 22px.

Tipografía:
- Familia: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif. (No Google Fonts.)
- Títulos: <h1> 22px, <h2> 18px, <h3> 16px. Espaciado vertical generoso (margin-top: 24px).
- Cuerpo: 16px, line-height 1.5.

Componentes recomendados (usá estos como bloques inline):
- Tarjeta: <div style="background:#fff;border-radius:8px;padding:16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08);">…</div>
- Etiqueta de estado: <span style="display:inline-block;padding:4px 10px;border-radius:12px;background:${colors.primary};color:#fff;font-size:12px;">CONFIRMADA</span>
- CTA visual (no funcional): <div style="background:${colors.accent};color:#fff;text-align:center;padding:12px;border-radius:6px;font-weight:600;">Llamar al consultorio</div>
- Línea divisoria: <hr style="border:0;border-top:1px solid #E0E0E0;margin:16px 0;">

Templates mínimos disponibles (elegí el que mejor encaje y ajustá contenido):
- "resumen-cita": header con clínica + tarjeta con fecha, hora, tratamiento, profesional + tarjeta con dirección y preparación + footer con teléfono.
- "confirmacion-formal": header + bloque de saludo + tarjeta con detalles + CTA + footer breve.
- "reporte-diario" (admin/staff): header + tabla simple de citas del día con status etiquetado + total + footer.
- "propuesta-comercial" (Bruno): header con logo + secciones <h2> ("Qué hace Bruno", "Inversión", "Próximos pasos") + CTA final.

Filename:
- Usá kebab-case sin extensión (la tool agrega .html). Ej: "resumen-cita-maria-15-mar".
- Siempre empezá con el tipo del template (resumen-cita, confirmacion, reporte-diario, propuesta).

Caption:
- Una sola línea, sin markdown. Ej: "Aquí va el resumen de tu cita del jueves."
- Si el HTML es autoexplicativo, omitir caption.`.trim();
}
