# Flujo multimedia (WhatsApp → Gemini)

Esta nota documenta cómo el agente de clínicas recibe imágenes, notas de voz,
videos, documentos y stickers desde WhatsApp y los pasa al modelo **nativamente**
(no como placeholder textual).

## Arquitectura

```
WhatsApp ─▶ Kapso ─▶ POST /webhook/kapso
                      │
                      ▼
          webhook.controller.processClinicasEvent
                      │
                      ├─ Step D: saveMessage (guarda texto "[Imagen] caption")
                      │
                      ├─ Step E: getHistorial (solo texto, tal cual)
                      │
                      ├─ Step E2: MediaPartsService.buildFromIncoming
                      │            · MediaService.procesarMediaPorId (buffer + Supabase)
                      │            · Valida MIME whitelist + tamaño por kind
                      │            · Genera GeminiPart[] (image | file)
                      │
                      ▼
          AiService.generarRespuestaClinicas(..., currentUserParts)
                      │
                      ├─ mergeMultimodalLastMessage()
                      │   → fusiona parts en el último mensaje user
                      │
                      └─ generateText({ model: gemini-3-flash-preview, messages })
```

## Archivos clave

| Archivo | Rol |
|---|---|
| `src/config/media.constants.ts` | `MAX_SIZES`, `ALLOWED_MIME`, `DOWNLOAD_TIMEOUT_MS`, `GEMINI_INLINE_MAX`, helpers `isMimeAllowed/isSizeAllowed` |
| `src/services/media-parts.service.ts` | `MediaPartsService.buildFromIncoming()` — descarga + valida + produce `GeminiPart[]` |
| `src/services/media.service.ts` | Descarga binaria + subida a Supabase Storage + inferencia MIME por magic bytes |
| `src/services/kapso.service.ts` | `downloadMedia()` con timeout 30 s vía proxy Kapso |
| `src/services/ai.service.ts` | `mergeMultimodalLastMessage()` + `generarRespuestaClinicas(..., currentUserParts?)` |
| `src/controllers/webhook.controller.ts` | Step E2 construye parts antes de llamar IA |

## Límites y MIME

| Modalidad | Max inline | MIME permitidos |
|---|---|---|
| image | 5 MB (redim. > 1.5 MB) | jpeg, png, webp, heic, heif |
| audio | 15 MB | ogg, mpeg, mp3, mp4/m4a, aac, wav, flac |
| video | 16 MB | mp4, 3gpp, mov, webm |
| document | 20 MB | application/pdf |
| sticker | 512 KB | image/webp |

Umbral inline → URL: si el buffer supera `GEMINI_INLINE_MAX` (15 MB), se intenta
enviar la URL pública de Supabase; si tampoco es posible, se degrada a texto.

## Fallback / degradación

El pipeline degrada silenciosamente a **solo texto** cuando:

- La descarga falla o vence el timeout.
- MIME no está en whitelist o tamaño excede el máximo.
- El buffer es >15 MB y no hay URL pública válida.

En ese caso, el agente recibe únicamente el literal `[Imagen]` / `[Nota de voz]` etc.
y el system prompt le instruye pedir amablemente el reenvío o la descripción por texto.

## Modelo

- Proveedor: `@ai-sdk/google` (Vercel AI SDK v6).
- Modelo default: `gemini-3-flash-preview` (1M contexto, multimodal).
- Tokens aproximados:
  - Imagen ≤384 px: 258 tok. Mayores: 258 × tiles 768×768.
  - Audio: 32 tok/seg.
  - PDF: 258 tok/página (texto nativo sin costo extra en Gemini 3).

## Tests

`src/__tests__/media-parts.service.test.ts` — 7 casos:

- No media → `null`.
- Imagen desde mediaId + caption → parts correctos.
- Voice/audio → añade prompt de transcripción.
- MIME no permitido → `null`.
- Imagen > 5 MB → `null`.
- PDF → part tipo `file` con `application/pdf`.
- MediaService falla → `null` (degradación).

## Próximos pasos (no implementados en este sprint)

- Generar voz con TTS (tool `sendVoiceReply`).
- Gemini Files API para audio >15 MB (notas de voz largas).
- Limpieza programada del bucket `mensajes` (TTL 90 días).
- Cache de transcripción/descripción en `messages.metadata.ai_summary`.
