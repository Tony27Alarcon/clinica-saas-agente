# TODO — Debug System + Tool Testing

## Estado actual (2026-05-12)

### Commit: ea09d03
Sistema de debug funcional. Onboarding de Bruno testeado end-to-end.
Pipeline de pacientes parcialmente testeado (tools se ejecutan, faltan datos de prueba).

---

## Pendiente: Pipeline Paciente (Clínica Bella)

### Prioridad alta — requiere data de prueba
- [ ] **Crear availability_slots** en BD para Clínica Bella (sin esto, `getAvailableSlots` retorna 0)
- [ ] **Probar bookAppointment** — reservar cita E2E (requiere slots disponibles)
- [ ] **Probar getAppointments** — consultar citas del paciente
- [ ] **Probar updateContactProfile** — el modelo no la llama cuando el paciente da su nombre (revisar prompt)

### Prioridad media — tools funcionales pero sin test E2E
- [ ] **Probar escalateToHuman** — escalar a staff humano
- [ ] **Probar sendInteractiveButtons / sendInteractiveList** — botones y listas de WhatsApp
- [ ] **Probar scheduleReminder / listReminders / cancelReminder** — recordatorios
- [ ] **Probar addNote / getNotes / editNote / archiveNote** — notas internas

### Prioridad baja
- [ ] **Probar noReply** — silenciar respuesta ante bots

## Pendiente: Pipeline Admin (sin empezar)

- [ ] **Probar con staff phone** — el debug controller no soporta pipeline admin aún
      (el admin se detecta por `findStaffByPhone`, no por company kind)
- [ ] Considerar agregar `pipeline` param al `/debug/simulate` para forzar admin
- [ ] Tools admin: searchContacts, getDailySummary, sendMessageToPatient, etc.

## Pendiente: Pipeline SuperAdmin (Bruno)

- [ ] **notifyStaff** — no probado, requiere advisors configurados
- [ ] **connect_google_calendar_owner** — requiere OAuth real
- [ ] **configure_availability** — requiere GCal conectado
- [ ] **send_kapso_connection_link** — ejecutó pero Bruno inventó URL en texto (verificar que la tool envíe el link real, no que Bruno lo escriba)

## Bugs conocidos

### Dermavida sin agente (no bloquea)
El `complete_onboarding` de ayer marcó `onboarding_completed_at` pero la company Dermavida
quedó sin agente ni canal en BD. Posible bug en `provisionClinic` o en la secuencia de tools.
Dermavida ID: `62c45466-2730-4220-8c87-11c8f6d8e325`. Puede borrarse o investigarse.

### Pipeline admin no alcanzable desde debug
El debug controller auto-detecta clinicas vs superadmin por `company.kind` / `BRUNO_LAB_COMPANY_ID`.
El pipeline admin se activa por `findStaffByPhone` dentro del webhook controller, que el debug no replica.
Opción: agregar param `pipeline: "admin"` al simulate y replicar los pasos del admin.

## Config de debug (.env)
```
DEBUG_PHONE_NUMBER="573197338787"
DEBUG_COMPANY_ID="dcd118f9-e31e-4a1c-9c05-4bcd0bd57217"   # Clínica Bella (TEST)
BRUNO_LAB_COMPANY_ID="062f4cb7-b06d-45ef-9e54-be684a07d239"
```

## Comandos rápidos
```bash
# Simular mensaje (pipeline auto-detectado por company)
curl -s -X POST http://localhost:3000/debug/simulate -H "Content-Type: application/json" \
  -d '{"text":"Hola", "new_session": true}'

# Simular en Bruno (SuperAdmin)
curl -s -X POST http://localhost:3000/debug/simulate -H "Content-Type: application/json" \
  -d '{"text":"Hola", "company_id": "062f4cb7-b06d-45ef-9e54-be684a07d239", "new_session": true}'

# Historial
curl -s http://localhost:3000/debug/history

# Reset
curl -s -X POST http://localhost:3000/debug/reset -H "Content-Type: application/json" -d '{}'
```
