Solicitud de cambio: Onboarding iniciado por agente
Tipo: Feature
Componente: Agente principal (Bruno) + Plataforma
Prioridad: A definir
Contexto
El onboarding de nuevas empresas será iniciado por el agente principal (Bruno) al detectar intención del usuario, en lugar de un flujo manual externo.
El esquema actual (clinicas.companies, clinicas.channels) ya soporta los campos necesarios: timezone, country_code, onboarding_completed_at, y channels.provider con phone_number.
Cambios requeridos
1. Nueva tool: start_onboarding

Exclusiva de Bruno (no expuesta a otros agentes).
Idempotente: si ya existe una company asociada al phone_number del interlocutor (vía channels) o al staff owner, no duplica; retorna el estado actual.
Las condiciones de disparo se definen en el system prompt del agente.

Acciones al ejecutarse:

Crea el registro en companies (incluye timezone, country_code, plan, slug).
Añade al usuario como staff con rol owner.
Asocia a Bruno con la compañía: cuando el interlocutor es el owner verificado, Bruno opera con capacidades de agente admin para esa empresa.

2. Nueva tool: send_kapso_connection_link

Envía al owner el link de Kapso para conectar su número de WhatsApp.
Al conectarse, se crea el registro correspondiente en channels (provider = 'whatsapp', provider_id, phone_number, access_token).
Trackea estado: pending / connected (sugerido: usar channels.active + campo en metadata).

3. Nueva tool: configure_availability (vía Google Calendar)

Modelo invertido: la disponibilidad se define bloqueando lo ocupado, no marcando lo libre. Los huecos del calendario = disponibilidad.
El agente opera sobre el Google Calendar del owner mediante la Google Calendar API.
Capacidades: crear, modificar y eliminar eventos con estado busy.
Los eventos creados por el agente deben llevar una marca identificable (propiedad extendida o tag en descripción) para no tocar eventos personales del owner.
La zona horaria se toma de companies.timezone.

4. Tool de soporte: autenticación con Google

Flujo OAuth para que el owner otorgue acceso a su calendario.
Requerido antes de que configure_availability pueda operar.
Tokens asociados al staff owner de la company.

Puntos a definir por el equipo

Normalizar formato de companies.timezone (el ejemplo trae Medellin/Colombia, el estándar IANA sería America/Bogota).
Estrategia de marcado de eventos del agente (recomendado: extendedProperties.private).
Manejo de revocación de permisos OAuth.
Dónde persistir el estado pending / connected del canal (¿channels.metadata o columna nueva?).

Criterios de aceptación

start_onboarding no crea duplicados ante llamadas repetidas.
Solo Bruno puede invocar start_onboarding.
Bruno adquiere permisos admin únicamente frente al owner verificado de cada empresa.
El agente puede crear, editar y eliminar eventos busy sin afectar eventos ajenos a su marca.
Los registros creados respetan el esquema actual de companies y channels.