-- ============================================================
-- Kapso History Import: IDs para deduplicación de mensajes
-- y vinculación de conversaciones con Kapso.
--
-- Correr en Supabase SQL Editor (o via migration tool).
-- ============================================================

-- Columna en conversations para vincular con el ID de conversación en Kapso.
-- Permite saber qué conversación de Kapso corresponde a la nuestra y
-- evitar crear conversaciones duplicadas al reconectar un número.
ALTER TABLE clinicas.conversations
  ADD COLUMN IF NOT EXISTS kapso_conversation_id TEXT;

-- Índice único parcial: solo aplica cuando el valor no es NULL,
-- así múltiples conversaciones sin vincular (NULL) coexisten sin conflicto.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_kapso_conversation_id_key
  ON clinicas.conversations(kapso_conversation_id)
  WHERE kapso_conversation_id IS NOT NULL;

-- Columna en messages para guardar el WAMID original de Kapso.
-- Permite hacer upsert/ON CONFLICT y no importar el mismo mensaje dos veces.
ALTER TABLE clinicas.messages
  ADD COLUMN IF NOT EXISTS kapso_message_id TEXT;

-- Índice único parcial: solo mensajes importados (con kapso_message_id) están
-- sujetos al constraint. Los mensajes generados por el agente tienen NULL.
CREATE UNIQUE INDEX IF NOT EXISTS messages_kapso_message_id_key
  ON clinicas.messages(kapso_message_id)
  WHERE kapso_message_id IS NOT NULL;

-- Índice de búsqueda para consultas por kapso_message_id
CREATE INDEX IF NOT EXISTS messages_kapso_message_id_idx
  ON clinicas.messages(kapso_message_id)
  WHERE kapso_message_id IS NOT NULL;
