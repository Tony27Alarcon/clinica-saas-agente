# Comando `/borrar` — Purga completa de un contacto

> Reset destructivo del estado de un contacto en una clínica. Pensado para
> **testing**: lo dispara el mismo número que escribe al WhatsApp del tenant.
> No requiere autenticación adicional (cualquiera con acceso al número puede
> ejecutarlo).

## Qué hace

El comando `/borrar` enviado al WhatsApp de la clínica purga todo rastro del
contacto que escribe y deja una conversación nueva vacía. La purga es **completa
y verificada**: si algún paso falla, el comando aborta sin sembrar la conv
limpia y notifica al usuario.

### Pasos (en orden, transaccionalmente independientes)

1. **Resolver `contact_id`** por `(company_id, phone)`. Si no existe → ok+noop.
2. **Cancelar eventos en Google Calendar** de toda cita activa (`appointments.gcal_event_id`).
   Best-effort: si el evento ya no existe (404/410) o el calendario no está
   configurado, se loggea warning y la purga continúa.
3. **Borrar archivos del bucket Storage `mensajes`** referenciados por:
   - `media_assets.storage_path` (con `storage_bucket = 'mensajes'`)
   - `clinical_forms.pdf_url` (extrayendo path de la URL pública)
4. **DELETE `media_assets`** por `contact_id`. Esta tabla no tiene FK CASCADE
   por diseño (ver `add_media_assets_clinicas.sql`), así que se borra explícito.
5. **Anonimizar `logs_eventos`**: `UPDATE SET contact_id=NULL,
   conversation_id=NULL WHERE contact_id=?`. Preserva la auditoría sin dejar
   rastro identificable del contacto.
6. **DELETE `contacts`** → `ON DELETE CASCADE` limpia automáticamente:
   - `conversations` (y vía esta, `messages`, `test_sessions`)
   - `appointments`, `clinical_forms`, `contacts_notas`,
     `follow_ups`, `scheduled_reminders`
7. **Verificación post-delete** (`verifyContactPurged`): cuenta filas
   restantes en cada tabla hija. Si alguna tiene `count > 0`, retorna
   `ok=false` con `residue:<tabla>:<count>`.

Sólo si los 7 pasos retornan `ok=true`, el handler crea contacto + conv +
mensaje seed `system` que bloquea el re-import del historial de Kapso en
Step C5.

## Implementación

| Pieza | Ubicación |
|---|---|
| Método de purga | `src/services/clinicas-db.service.ts` → `ClinicasDbService.purgeContactCompletely` |
| Helper de verificación | `src/services/clinicas-db.service.ts` → `ClinicasDbService.verifyContactPurged` |
| Extractor de path de Storage | `src/services/clinicas-db.service.ts` → `extractMensajesPath` (interno) |
| Handler `/borrar` | `src/controllers/webhook.controller.ts` (sección "Comando /borrar (testing)") |
| Tests | `src/__tests__/clinicas-db.purge.test.ts` (7 casos) |

## Contrato de retorno

```ts
{
  ok: boolean;                    // false → caller NO debe sembrar conv limpia
  contactId: string | null;       // null si no existía contacto
  counts: {
    gcalEventsCancelled: number;
    storageFilesRemoved: number;
    mediaAssetsRows: number;
    logsAnonymized: number;
  };
  warnings: string[];             // best-effort issues (gcal, storage)
  error?: string;                 // sólo si ok=false
}
```

`warnings` codifica problemas non-fatal con prefijo de tipo:
`gcal_cancel_failed:<eventId>:<msg>`, `storage_remove_failed:<msg>`,
`media_assets_lookup_failed:<msg>`, etc. No abortan la purga.

`error` aparece sólo en fallo terminal, con prefijos:
- `contact_delete_failed:<msg>` — el `DELETE FROM contacts` rechazó la
  operación (típicamente FK violation por CASCADE no aplicado o RLS).
- `residue_after_delete:<tabla>:<count>,...` — el delete pareció exitoso pero
  la verificación encontró filas huérfanas.

## Lo que NO se borra (decisiones explícitas)

| Dato | Razón | Mitigación |
|---|---|---|
| Filas de `logs_eventos` | Auditoría: trazabilidad operativa por `request_id`/`event_code`. | Se anonimiza: `contact_id` y `conversation_id` quedan en `NULL`. |
| Conversación en Kapso (estado externo) | Es del proveedor; sin API de borrado expuesta. | El mensaje seed bloquea el re-import desde Kapso (`hasMessages = true` ⇒ Step C5 se salta). |
| Archivos en otros buckets que no sean `mensajes` | Por diseño, todo el storage del agente vive en `mensajes`. | Si en el futuro se agrega otro bucket, ampliar `purgeContactCompletely`. |

## Pruebas

```bash
npx vitest run src/__tests__/clinicas-db.purge.test.ts
```

Los 7 casos cubren:
1. `contact_not_found` → ok+noop sin side-effects
2. Happy path: GCal cancela 1 evento, storage borra 3 archivos
   (2 media + 1 PDF), media_assets borra 2 filas, logs anonimiza 2 filas,
   contact eliminado, CASCADE limpia tablas hijas
3. GCal cancel falla → warning, purga continúa
4. Storage remove falla → warning, purga continúa
5. `DELETE FROM contacts` falla → `ok=false`, contact NO se borra
6. `verifyContactPurged` detecta residuos cuando CASCADE no funcionó
7. `verifyContactPurged` retorna `clean=true` en escenario limpio

## Auditoría del bug previo (commit anterior)

Antes de este cambio el handler era:

```ts
await ClinicasDbService.deleteContact(company.id, from);   // ← retorna false silencioso
const freshContact = await getOrCreateContact(...);         // ← devolvía el contacto VIEJO
const freshConv    = await getOrCreateConversation(...);    // ← devolvía conv VIEJA con todo el historial
await saveMessage(freshConv.id, 'system', '--- ... ---');   // ← seed appended al final del historial
```

Cuando `delete from contacts` fallaba (FK no-CASCADE en algún hijo, RLS,
network), el flujo seguía como si nada y el LLM continuaba viendo todo el
historial. El usuario percibía que `/borrar` no había hecho nada — porque
efectivamente no lo hacía.

Adicionalmente, incluso con CASCADE perfecto, sobrevivían:
- Filas en `clinicas.media_assets` (sin FK por diseño deliberado)
- Filas en `clinicas.logs_eventos` (sin FK)
- Archivos físicos en bucket `mensajes`
- PDFs en `clinical_forms.pdf_url`
- Eventos en Google Calendar de los staff

`purgeContactCompletely` ataca cada uno de esos vectores y verifica el
resultado.
