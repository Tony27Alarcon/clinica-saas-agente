# Lessons Learned — clinica-saas-agente

## gemini-3.1-flash-lite + tool calling (2026-05-12)

### Problema: respuestas vacías tras tool calls
El modelo `gemini-3.1-flash-lite-preview` frecuentemente ejecuta tools pero termina
con `finishReason=tool-calls` sin generar texto de respuesta. Esto afecta los 3 pipelines.

### Solución aplicada (commit ea09d03)
Patrón de 3 llamadas escalonadas:
1. **Primera llamada** con tools + maxSteps → ejecuta tools pero puede no generar texto
2. **Segunda llamada (follow-up)** con tools + mensajes intermedios → a veces ejecuta MÁS tools sin texto
3. **Tercera llamada SIN tools** → fuerza al modelo a generar texto obligatoriamente

Este patrón se aplicó en SuperAdmin y Clinicas. Falta aplicarlo en Admin y Onboarding si presentan el mismo problema.

### google_search incompatible
`google.tools.googleSearch({})` (provider-defined tool) es incompatible con function tools
en flash-lite. El SDK lanza warning: `"combination of function and provider-defined tools" is not supported`.
Se removió de SuperAdmin. Si se necesita grounding, usar un modelo superior o llamar googleSearch en una request separada.

## Idempotencia de start_onboarding (2026-05-12)

### Problema: phone mismatch
`findPendingOnboardingByOwner` buscaba con `normalizePhone()` que stripea el prefijo `57`,
pero `provisionClinic` guarda el phone raw con prefijo. Nunca matcheaba.

### Fix
Se cambió a buscar con `.in('phone', [raw, normalized])` para cubrir ambas variantes.

## Tools con company_id incorrecto (2026-05-12)

### Problema
El LLM (flash-lite) confunde UUIDs entre tool calls. Pasaba company_id de Bruno Lab
en vez de la Dermavida recién creada.

### Fix
`resolveCompanyId(llmCompanyId, ownerPhone)` — valida que el company_id exista en BD,
y si no, hace fallback buscando la company del owner por teléfono. Aplicado a todas
las tools del onboarding via closure.
