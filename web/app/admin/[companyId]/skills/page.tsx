'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type SkillKind = 'system' | 'private';

interface SkillView {
    id?:         string;
    kind:        SkillKind;
    skill_id:    string;
    name:        string;
    trigger:     string;
    guidelines:  string;
    enabled:     boolean;
    can_edit:    boolean;
    can_delete:  boolean;
    updated_at?: string | null;
}

interface SkillsResponse {
    system:  SkillView[];
    private: SkillView[];
}

interface PrivateForm {
    skill_id:   string;
    name:       string;
    trigger:    string;
    guidelines: string;
}

const EMPTY_FORM: PrivateForm = { skill_id: '', name: '', trigger: '', guidelines: '' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// ─── Página ───────────────────────────────────────────────────────────────────

export default function SkillsPage() {
    const { companyId } = useParams<{ companyId: string }>();
    const [data, setData]       = useState<SkillsResponse>({ system: [], private: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);   // skill_id en edición
    const [creating, setCreating]   = useState(false);
    const [form, setForm]       = useState<PrivateForm>(EMPTY_FORM);
    const [savingId, setSavingId]   = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(`/api/admin/${companyId}/skills`, { cache: 'no-store' });
            if (!r.ok) throw new Error((await r.json()).error ?? 'Error cargando skills');
            const json: SkillsResponse = await r.json();
            setData(json);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [companyId]);

    useEffect(() => { load(); }, [load]);

    // ── Toggle (system o private) ────────────────────────────────────────────
    async function toggle(s: SkillView, next: boolean) {
        setSavingId(s.skill_id);
        try {
            const r = await fetch(
                `/api/admin/${companyId}/skills/${s.skill_id}?kind=${s.kind}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: next }),
                }
            );
            if (!r.ok) throw new Error((await r.json()).error);
            await load();
        } catch (e: any) {
            alert(`No se pudo actualizar: ${e.message}`);
        } finally {
            setSavingId(null);
        }
    }

    // ── Crear privada ────────────────────────────────────────────────────────
    function startCreate() {
        setForm(EMPTY_FORM);
        setCreating(true);
        setEditingId(null);
    }

    async function submitCreate() {
        const err = validateForm(form);
        if (err) { alert(err); return; }

        setSavingId('__new__');
        try {
            const r = await fetch(`/api/admin/${companyId}/skills`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            if (!r.ok) throw new Error((await r.json()).error);
            setCreating(false);
            setForm(EMPTY_FORM);
            await load();
        } catch (e: any) {
            alert(`No se pudo crear: ${e.message}`);
        } finally {
            setSavingId(null);
        }
    }

    // ── Editar privada ───────────────────────────────────────────────────────
    function startEdit(s: SkillView) {
        setForm({
            skill_id:   s.skill_id,
            name:       s.name,
            trigger:    s.trigger,
            guidelines: s.guidelines,
        });
        setEditingId(s.skill_id);
        setCreating(false);
    }

    async function submitEdit() {
        if (!editingId) return;
        if (!form.name.trim() || !form.trigger.trim() || form.guidelines.trim().length < 30) {
            alert('Completá nombre, trigger y guidelines (mín. 30 chars).');
            return;
        }
        setSavingId(editingId);
        try {
            const r = await fetch(`/api/admin/${companyId}/skills/${editingId}?kind=private`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name:       form.name,
                    trigger:    form.trigger,
                    guidelines: form.guidelines,
                }),
            });
            if (!r.ok) throw new Error((await r.json()).error);
            setEditingId(null);
            setForm(EMPTY_FORM);
            await load();
        } catch (e: any) {
            alert(`No se pudo guardar: ${e.message}`);
        } finally {
            setSavingId(null);
        }
    }

    async function deletePrivate(s: SkillView) {
        if (!confirm(`¿Borrar la skill privada "${s.name}"? Esta acción no se puede deshacer.`)) return;
        setSavingId(s.skill_id);
        try {
            const r = await fetch(`/api/admin/${companyId}/skills/${s.skill_id}?kind=private`, { method: 'DELETE' });
            if (!r.ok) throw new Error((await r.json()).error);
            await load();
        } catch (e: any) {
            alert(`No se pudo borrar: ${e.message}`);
        } finally {
            setSavingId(null);
        }
    }

    // ── Render ───────────────────────────────────────────────────────────────
    if (loading) return <div style={{ padding: 32 }}>Cargando skills…</div>;
    if (error)   return <div style={{ padding: 32, color: 'crimson' }}>{error}</div>;

    return (
        <div style={{ padding: 32, maxWidth: 1000 }}>
            <header style={{ marginBottom: 24 }}>
                <h1 style={{ fontFamily: 'var(--font-epilogue)', fontSize: 28, margin: 0 }}>Skills del agente</h1>
                <p style={{ color: '#666', marginTop: 8 }}>
                    Las <strong>reglas fundamentales</strong> del agente (formato WhatsApp, humanización, seguridad)
                    siempre aplican y no son editables. Estas skills son <strong>complementarias</strong>:
                    podés activar/desactivar las de sistema y crear las propias de tu clínica.
                </p>
                <p style={{ color: '#666', marginTop: 4, fontSize: 13 }}>
                    <strong>Prioridad:</strong> reglas base → skills de sistema activas → skills privadas activas.
                    Si una skill privada contradice las base, las base ganan.
                </p>
            </header>

            {/* ─── Skills de Sistema ────────────────────────────────────────── */}
            <section style={{ marginBottom: 40 }}>
                <h2 style={{ fontSize: 20, marginBottom: 12 }}>Skills de sistema</h2>
                <div style={{ display: 'grid', gap: 12 }}>
                    {data.system.map(s => (
                        <SkillCard
                            key={`s:${s.skill_id}`}
                            skill={s}
                            saving={savingId === s.skill_id}
                            onToggle={(next) => toggle(s, next)}
                        />
                    ))}
                </div>
            </section>

            {/* ─── Skills Privadas ──────────────────────────────────────────── */}
            <section>
                <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <h2 style={{ fontSize: 20, margin: 0 }}>Skills privadas</h2>
                    {!creating && (
                        <button onClick={startCreate} style={btnPrimary}>+ Nueva skill privada</button>
                    )}
                </header>

                {creating && (
                    <PrivateFormView
                        form={form}
                        setForm={setForm}
                        title="Nueva skill privada"
                        onSubmit={submitCreate}
                        onCancel={() => { setCreating(false); setForm(EMPTY_FORM); }}
                        saving={savingId === '__new__'}
                        editing={false}
                    />
                )}

                {data.private.length === 0 && !creating && (
                    <p style={{ color: '#888', fontStyle: 'italic' }}>
                        Todavía no creaste skills privadas. Usá el botón superior para empezar.
                    </p>
                )}

                <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                    {data.private.map(s => (
                        editingId === s.skill_id ? (
                            <PrivateFormView
                                key={`p:${s.skill_id}`}
                                form={form}
                                setForm={setForm}
                                title={`Editando: ${s.name}`}
                                onSubmit={submitEdit}
                                onCancel={() => { setEditingId(null); setForm(EMPTY_FORM); }}
                                saving={savingId === s.skill_id}
                                editing={true}
                            />
                        ) : (
                            <SkillCard
                                key={`p:${s.skill_id}`}
                                skill={s}
                                saving={savingId === s.skill_id}
                                onToggle={(next) => toggle(s, next)}
                                onEdit={() => startEdit(s)}
                                onDelete={() => deletePrivate(s)}
                            />
                        )
                    ))}
                </div>
            </section>
        </div>
    );
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

function SkillCard(props: {
    skill:    SkillView;
    saving:   boolean;
    onToggle: (next: boolean) => void;
    onEdit?:  () => void;
    onDelete?:() => void;
}) {
    const { skill: s, saving, onToggle, onEdit, onDelete } = props;
    const [open, setOpen] = useState(false);

    return (
        <div style={{
            border: '1px solid #e2e2e2', borderRadius: 8, padding: 16,
            background: s.enabled ? '#fff' : '#fafafa',
            opacity: s.enabled ? 1 : 0.75,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 4,
                            background: s.kind === 'system' ? '#eef2ff' : '#fef3c7',
                            color:      s.kind === 'system' ? '#3730a3' : '#92400e',
                        }}>
                            {s.kind === 'system' ? 'Sistema' : 'Privada'}
                        </span>
                        <strong style={{ fontSize: 15 }}>{s.name}</strong>
                        <code style={{ fontSize: 11, color: '#888' }}>{s.skill_id}</code>
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 13, color: '#555' }}>
                        <strong>Activa cuando:</strong> {s.trigger}
                    </p>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={saving}
                        onChange={(e) => onToggle(e.target.checked)}
                    />
                    <span style={{ fontSize: 13 }}>{s.enabled ? 'Activa' : 'Inactiva'}</span>
                </label>
            </div>

            <button
                onClick={() => setOpen(!open)}
                style={{ marginTop: 8, fontSize: 12, color: '#555', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
                {open ? '▾ Ocultar instrucciones' : '▸ Ver instrucciones'}
            </button>

            {open && (
                <pre style={{
                    marginTop: 8, padding: 12, background: '#f7f7f7', borderRadius: 6,
                    fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit',
                }}>
                    {s.guidelines}
                </pre>
            )}

            {(onEdit || onDelete) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {onEdit && <button onClick={onEdit} style={btnSecondary} disabled={saving}>Editar</button>}
                    {onDelete && <button onClick={onDelete} style={btnDanger} disabled={saving}>Borrar</button>}
                </div>
            )}
        </div>
    );
}

function PrivateFormView(props: {
    form:    PrivateForm;
    setForm: (f: PrivateForm) => void;
    title:   string;
    onSubmit:() => void;
    onCancel:() => void;
    saving:  boolean;
    editing: boolean;
}) {
    const { form, setForm, title, onSubmit, onCancel, saving, editing } = props;
    return (
        <div style={{ border: '2px solid #6366f1', borderRadius: 8, padding: 16, background: '#f5f5ff' }}>
            <h3 style={{ marginTop: 0 }}>{title}</h3>
            <p style={{ fontSize: 12, color: '#555' }}>
                Mismo protocolo que las skills de sistema: <code>id</code>, <code>name</code>, <code>trigger</code>, <code>guidelines</code>.
                Las skills privadas <strong>complementan</strong> las reglas base; nunca las anulan.
            </p>

            <Field label="ID (slug, ej: promo-septiembre-botox)">
                <input
                    type="text"
                    value={form.skill_id}
                    disabled={editing || saving}
                    onChange={e => setForm({ ...form, skill_id: e.target.value.toLowerCase() })}
                    style={input}
                    placeholder="lowercase, números, guiones"
                />
            </Field>

            <Field label="Nombre legible">
                <input
                    type="text"
                    value={form.name}
                    disabled={saving}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    style={input}
                    placeholder="Ej: Promoción Septiembre Botox"
                />
            </Field>

            <Field label="Trigger (cuándo activar)">
                <input
                    type="text"
                    value={form.trigger}
                    disabled={saving}
                    onChange={e => setForm({ ...form, trigger: e.target.value })}
                    style={input}
                    placeholder="Ej: Cuando el paciente pregunte por promociones de Botox"
                />
            </Field>

            <Field label="Guidelines (instrucciones detalladas, mínimo 30 chars)">
                <textarea
                    value={form.guidelines}
                    disabled={saving}
                    onChange={e => setForm({ ...form, guidelines: e.target.value })}
                    style={{ ...input, minHeight: 120, fontFamily: 'inherit' }}
                    placeholder="Pasos concretos, ejemplos, qué decir y qué evitar."
                />
                <small style={{ color: '#666' }}>{form.guidelines.length} chars</small>
            </Field>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={onSubmit} disabled={saving} style={btnPrimary}>
                    {saving ? 'Guardando…' : (editing ? 'Guardar cambios' : 'Crear skill')}
                </button>
                <button onClick={onCancel} disabled={saving} style={btnSecondary}>Cancelar</button>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</label>
            {children}
        </div>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateForm(f: PrivateForm): string | null {
    if (!SLUG_RE.test(f.skill_id))         return 'ID debe ser slug lowercase: a-z, 0-9, guiones (2-64 chars).';
    if (!f.name.trim())                    return 'Nombre obligatorio.';
    if (!f.trigger.trim())                 return 'Trigger obligatorio.';
    if (f.guidelines.trim().length < 30)   return 'Guidelines debe tener al menos 30 chars.';
    return null;
}

const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d4d4d4',
    fontSize: 14, boxSizing: 'border-box',
};
const btnPrimary: React.CSSProperties = {
    padding: '8px 16px', borderRadius: 6, border: 'none', background: '#6366f1',
    color: 'white', cursor: 'pointer', fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
    padding: '6px 12px', borderRadius: 6, border: '1px solid #d4d4d4', background: 'white', cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
    padding: '6px 12px', borderRadius: 6, border: '1px solid #fca5a5',
    background: 'white', color: '#b91c1c', cursor: 'pointer',
};
