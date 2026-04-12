'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Objection {
    objection: string;
    response: string;
}

interface AgentData {
    id: string;
    name: string;
    tone: 'formal' | 'amigable' | 'casual';
    system_prompt: string;
    qualification_criteria: {
        min_budget_usd?: number;
        excluded_keywords?: string[];
    };
    escalation_rules: {
        trigger_keywords?: string[];
        max_unanswered_turns?: number;
    };
    objections_kb: Objection[];
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// ─── Auto-resize textarea ─────────────────────────────────────────────────────

function useAutoResize(value: string) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    return ref;
}

// ─── Tag Input ────────────────────────────────────────────────────────────────

function TagInput({
    tags,
    onChange,
    placeholder,
}: {
    tags: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string;
}) {
    const [input, setInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    function commit(raw: string) {
        const val = raw.trim();
        if (val && !tags.includes(val)) onChange([...tags, val]);
        setInput('');
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input); }
        if (e.key === 'Backspace' && input === '' && tags.length > 0) onChange(tags.slice(0, -1));
    }

    return (
        <div className="tag-input" onClick={() => inputRef.current?.focus()}>
            {tags.map((tag, i) => (
                <span key={i} className="tag-chip">
                    {tag}
                    <button
                        type="button"
                        className="tag-chip-remove"
                        onClick={e => { e.stopPropagation(); onChange(tags.filter((_, j) => j !== i)); }}
                    >
                        ×
                    </button>
                </span>
            ))}
            <input
                ref={inputRef}
                className="tag-chip-input"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={() => input && commit(input)}
                placeholder={tags.length === 0 ? placeholder : ''}
            />
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AgentePage() {
    const { companyId } = useParams<{ companyId: string }>();

    const [agent,  setAgent]  = useState<AgentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [status,  setStatus]  = useState<SaveStatus>('idle');
    const [errorMsg, setErrorMsg] = useState('');

    const promptRef = useAutoResize(agent?.system_prompt ?? '');

    // ── Fetch ──────────────────────────────────────────────────────────────────
    useEffect(() => {
        fetch(`/api/admin/${companyId}/agent`)
            .then(r => r.json())
            .then(data => {
                setAgent({
                    ...data,
                    qualification_criteria: data.qualification_criteria ?? {},
                    escalation_rules:       data.escalation_rules       ?? {},
                    objections_kb:          data.objections_kb           ?? [],
                });
            })
            .finally(() => setLoading(false));
    }, [companyId]);

    // ── Save ───────────────────────────────────────────────────────────────────
    async function save() {
        if (!agent || status === 'saving') return;
        setStatus('saving');
        setErrorMsg('');
        try {
            const res = await fetch(`/api/admin/${companyId}/agent`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(agent),
            });
            if (!res.ok) {
                const json = await res.json();
                throw new Error(json.error ?? 'Error desconocido');
            }
            setStatus('saved');
            setTimeout(() => setStatus('idle'), 3000);
        } catch (err: any) {
            setErrorMsg(err.message);
            setStatus('error');
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function set<K extends keyof AgentData>(key: K, val: AgentData[K]) {
        setAgent(p => p ? { ...p, [key]: val } : p);
    }

    function setQC(key: string, val: unknown) {
        setAgent(p => p ? { ...p, qualification_criteria: { ...p.qualification_criteria, [key]: val } } : p);
    }

    function setER(key: string, val: unknown) {
        setAgent(p => p ? { ...p, escalation_rules: { ...p.escalation_rules, [key]: val } } : p);
    }

    function addObjection() {
        setAgent(p => p ? { ...p, objections_kb: [...p.objections_kb, { objection: '', response: '' }] } : p);
    }

    function setObjection(i: number, key: 'objection' | 'response', val: string) {
        setAgent(p => {
            if (!p) return p;
            const next = p.objections_kb.map((o, j) => j === i ? { ...o, [key]: val } : o);
            return { ...p, objections_kb: next };
        });
    }

    function removeObjection(i: number) {
        setAgent(p => p ? { ...p, objections_kb: p.objections_kb.filter((_, j) => j !== i) } : p);
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="agente-loading">
                <div className="agente-spinner" />
                <p>Cargando configuración del agente...</p>
            </div>
        );
    }

    if (!agent) {
        return (
            <div className="agente-loading">
                <p style={{ color: 'var(--admin-muted)' }}>No se encontró un agente configurado para esta clínica.</p>
            </div>
        );
    }

    const saveLabel = status === 'saving' ? 'Guardando...' : 'Guardar cambios';

    return (
        <div className="agente-page">

            {/* ── Top bar ──────────────────────────────────────────────────── */}
            <div className="agente-topbar">
                <div className="agente-topbar-info">
                    <h1 className="agente-title">Agente IA</h1>
                    <p className="agente-subtitle">Instrucciones y comportamiento de <strong>{agent.name}</strong></p>
                </div>
                <div className="agente-topbar-actions">
                    {status === 'saved' && <span className="save-status save-status--ok">Guardado</span>}
                    {status === 'error' && <span className="save-status save-status--err">{errorMsg}</span>}
                    <button className="btn-save" onClick={save} disabled={status === 'saving'}>
                        {saveLabel}
                    </button>
                </div>
            </div>

            {/* ── 1. Identidad ─────────────────────────────────────────────── */}
            <section className="admin-card">
                <div className="card-header">
                    <span className="card-header-icon">✦</span>
                    <div>
                        <h2 className="card-title">Identidad</h2>
                        <p className="card-subtitle">Nombre y personalidad base del agente</p>
                    </div>
                </div>
                <div className="card-body">
                    <div className="field">
                        <label className="field-label">Nombre del agente</label>
                        <input
                            className="field-input"
                            value={agent.name}
                            onChange={e => set('name', e.target.value)}
                            placeholder="Ej: Valentina, Sofía, Clara..."
                        />
                    </div>

                    <div className="field">
                        <label className="field-label">Tono de comunicación</label>
                        <div className="tone-grid">
                            {([
                                { value: 'formal',   icon: '🎩', label: 'Formal',   desc: 'Trato respetuoso, tuteo de usted' },
                                { value: 'amigable', icon: '😊', label: 'Amigable', desc: 'Cercano y cálido, tuteo de tú' },
                                { value: 'casual',   icon: '😎', label: 'Casual',   desc: 'Relajado, puede usar emojis' },
                            ] as const).map(t => (
                                <button
                                    key={t.value}
                                    type="button"
                                    className={`tone-card ${agent.tone === t.value ? 'tone-card--active' : ''}`}
                                    onClick={() => set('tone', t.value)}
                                >
                                    <span className="tone-card-icon">{t.icon}</span>
                                    <span className="tone-card-label">{t.label}</span>
                                    <span className="tone-card-desc">{t.desc}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* ── 2. System Prompt ─────────────────────────────────────────── */}
            <section className="admin-card">
                <div className="card-header">
                    <span className="card-header-icon">⌘</span>
                    <div>
                        <h2 className="card-title">Instrucciones del sistema</h2>
                        <p className="card-subtitle">Contexto y reglas base que el agente tiene en cada conversación</p>
                    </div>
                </div>
                <div className="card-body">
                    <div className="editor-wrap">
                        <div className="editor-topbar">
                            <span className="editor-badge">system_prompt</span>
                            <span className="editor-chars">{agent.system_prompt.length.toLocaleString('es')} caracteres</span>
                        </div>
                        <textarea
                            ref={promptRef}
                            className="editor-textarea"
                            value={agent.system_prompt}
                            onChange={e => set('system_prompt', e.target.value)}
                            placeholder={'Eres Valentina, la asistente de Clínica Aurora.\nTu objetivo es calificar leads y agendar citas...\n\nReglas:\n- Siempre responder en español\n- ...'}
                            rows={14}
                            spellCheck={false}
                        />
                        <p className="field-hint">
                            Este prompt se combina automáticamente con los tratamientos activos de la clínica cada vez que el agente responde.
                        </p>
                    </div>
                </div>
            </section>

            {/* ── 3. Calificación de Leads ─────────────────────────────────── */}
            <section className="admin-card">
                <div className="card-header">
                    <span className="card-header-icon">◎</span>
                    <div>
                        <h2 className="card-title">Calificación de leads</h2>
                        <p className="card-subtitle">Criterios para que el agente clasifique o descarte un prospecto</p>
                    </div>
                </div>
                <div className="card-body">
                    <div className="field field--short">
                        <label className="field-label">Presupuesto mínimo (USD)</label>
                        <input
                            className="field-input"
                            type="number"
                            min={0}
                            value={agent.qualification_criteria.min_budget_usd ?? ''}
                            onChange={e => setQC('min_budget_usd', e.target.value ? Number(e.target.value) : undefined)}
                            placeholder="80"
                        />
                        <p className="field-hint">Leads con presupuesto menor a este valor se clasifican como no calificados.</p>
                    </div>

                    <div className="field">
                        <label className="field-label">Palabras clave para descartar</label>
                        <TagInput
                            tags={agent.qualification_criteria.excluded_keywords ?? []}
                            onChange={val => setQC('excluded_keywords', val)}
                            placeholder="Escribe y presiona Enter — Ej: gratis, regalo, intercambio"
                        />
                        <p className="field-hint">Si el lead menciona alguna de estas palabras, el agente lo descarta automáticamente.</p>
                    </div>
                </div>
            </section>

            {/* ── 4. Escalamiento ──────────────────────────────────────────── */}
            <section className="admin-card">
                <div className="card-header">
                    <span className="card-header-icon">↑</span>
                    <div>
                        <h2 className="card-title">Escalamiento a humano</h2>
                        <p className="card-subtitle">Cuándo el agente transfiere la conversación al equipo</p>
                    </div>
                </div>
                <div className="card-body">
                    <div className="field">
                        <label className="field-label">Frases que activan el escalamiento</label>
                        <TagInput
                            tags={agent.escalation_rules.trigger_keywords ?? []}
                            onChange={val => setER('trigger_keywords', val)}
                            placeholder='Escribe y presiona Enter — Ej: hablar con alguien, quiero cancelar'
                        />
                        <p className="field-hint">Cuando el paciente escribe alguna de estas frases, la conversación se transfiere automáticamente.</p>
                    </div>

                    <div className="field field--short">
                        <label className="field-label">Turnos sin respuesta antes de escalar</label>
                        <input
                            className="field-input"
                            type="number"
                            min={1}
                            max={20}
                            value={agent.escalation_rules.max_unanswered_turns ?? ''}
                            onChange={e => setER('max_unanswered_turns', e.target.value ? Number(e.target.value) : undefined)}
                            placeholder="6"
                        />
                        <p className="field-hint">Después de N mensajes sin respuesta, el agente notifica al equipo.</p>
                    </div>
                </div>
            </section>

            {/* ── 5. Manejo de Objeciones ──────────────────────────────────── */}
            <section className="admin-card">
                <div className="card-header">
                    <span className="card-header-icon">💬</span>
                    <div style={{ flex: 1 }}>
                        <h2 className="card-title">Manejo de objeciones</h2>
                        <p className="card-subtitle">Respuestas entrenadas para las dudas más frecuentes del paciente</p>
                    </div>
                    <button type="button" className="btn-secondary" onClick={addObjection}>
                        + Agregar objeción
                    </button>
                </div>
                <div className="card-body">
                    {agent.objections_kb.length === 0 ? (
                        <div className="empty-state">
                            <p className="empty-state-title">Sin objeciones configuradas</p>
                            <p className="empty-state-desc">
                                Agrega respuestas para preguntas frecuentes como<br />
                                "¿es seguro?", "¿es muy caro?", "¿cuánto dura el efecto?"
                            </p>
                            <button type="button" className="btn-secondary" onClick={addObjection}>
                                + Agregar primera objeción
                            </button>
                        </div>
                    ) : (
                        <div className="objections-list">
                            {agent.objections_kb.map((obj, i) => (
                                <div key={i} className="objection-row">
                                    <span className="objection-num">{i + 1}</span>
                                    <div className="objection-fields">
                                        <div className="field">
                                            <label className="field-label">Paciente dice</label>
                                            <textarea
                                                className="field-textarea"
                                                value={obj.objection}
                                                onChange={e => setObjection(i, 'objection', e.target.value)}
                                                placeholder='Ej: "Es muy caro, no tengo ese presupuesto ahora mismo"'
                                                rows={2}
                                            />
                                        </div>
                                        <div className="field">
                                            <label className="field-label">Agente responde</label>
                                            <textarea
                                                className="field-textarea"
                                                value={obj.response}
                                                onChange={e => setObjection(i, 'response', e.target.value)}
                                                placeholder='Ej: "Entiendo tu preocupación. Contamos con planes de pago en cuotas sin interés..."'
                                                rows={2}
                                            />
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className="objection-remove"
                                        onClick={() => removeObjection(i)}
                                        title="Eliminar objeción"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}

                            <button type="button" className="btn-secondary btn-add-more" onClick={addObjection}>
                                + Agregar otra objeción
                            </button>
                        </div>
                    )}
                </div>
            </section>

            {/* ── Bottom save bar ──────────────────────────────────────────── */}
            <div className="bottom-bar">
                {status === 'saved' && <span className="save-status save-status--ok">Cambios guardados correctamente</span>}
                {status === 'error' && <span className="save-status save-status--err">{errorMsg}</span>}
                <button className="btn-save" onClick={save} disabled={status === 'saving'}>
                    {saveLabel}
                </button>
            </div>

        </div>
    );
}
