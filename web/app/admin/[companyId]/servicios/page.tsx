'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Service {
    id: string;
    name: string;
    description: string | null;
    price_min: number | null;
    price_max: number | null;
    duration_min: number | null;
    category: string | null;
    active: boolean;
}

interface FormData {
    name: string;
    description: string;
    price_min: string;
    price_max: string;
    duration_min: string;
    category: string;
}

const EMPTY_FORM: FormData = {
    name: '',
    description: '',
    price_min: '',
    price_max: '',
    duration_min: '',
    category: '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(s: Service): string | null {
    if (s.price_min == null && s.price_max == null) return null;
    if (s.price_min != null && s.price_max != null && +s.price_min !== +s.price_max) {
        return `$${s.price_min} – $${s.price_max}`;
    }
    return `$${s.price_min ?? s.price_max}`;
}

function formatDuration(min: number | null): string | null {
    if (!min) return null;
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function serviceToForm(s: Service): FormData {
    return {
        name: s.name,
        description: s.description ?? '',
        price_min: s.price_min != null ? String(s.price_min) : '',
        price_max: s.price_max != null ? String(s.price_max) : '',
        duration_min: s.duration_min != null ? String(s.duration_min) : '',
        category: s.category ?? '',
    };
}

function formToBody(f: FormData) {
    return {
        name: f.name.trim(),
        description: f.description.trim() || null,
        price_min: f.price_min ? Number(f.price_min) : null,
        price_max: f.price_max ? Number(f.price_max) : null,
        duration_min: f.duration_min ? Number(f.duration_min) : null,
        category: f.category.trim() || null,
    };
}

// ─── Service Form ─────────────────────────────────────────────────────────────

function ServiceForm({
    form,
    onChange,
    onSave,
    onCancel,
    saving,
    isNew,
}: {
    form: FormData;
    onChange: (f: FormData) => void;
    onSave: () => void;
    onCancel: () => void;
    saving: boolean;
    isNew: boolean;
}) {
    function set(key: keyof FormData, val: string) {
        onChange({ ...form, [key]: val });
    }

    return (
        <section className="admin-card">
            <div className="card-header">
                <span className="card-header-icon">{isNew ? '✦' : '✎'}</span>
                <div>
                    <h2 className="card-title">{isNew ? 'Nuevo servicio' : 'Editar servicio'}</h2>
                    <p className="card-subtitle">
                        {isNew
                            ? 'Agrega un tratamiento al catálogo de tu clínica'
                            : 'Modifica los datos de este servicio'}
                    </p>
                </div>
            </div>
            <div className="card-body">
                <div className="field">
                    <label className="field-label">Nombre del servicio *</label>
                    <input
                        className="field-input"
                        value={form.name}
                        onChange={e => set('name', e.target.value)}
                        placeholder="Ej: Botox facial, Limpieza profunda, Relleno de labios..."
                        autoFocus
                    />
                </div>

                <div className="field">
                    <label className="field-label">Descripción</label>
                    <textarea
                        className="field-textarea"
                        value={form.description}
                        onChange={e => set('description', e.target.value)}
                        placeholder="Breve descripción para que el agente pueda informar al paciente"
                        rows={3}
                    />
                </div>

                <div className="service-form-row">
                    <div className="field">
                        <label className="field-label">Precio mínimo</label>
                        <input
                            className="field-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={form.price_min}
                            onChange={e => set('price_min', e.target.value)}
                            placeholder="50"
                        />
                    </div>
                    <div className="field">
                        <label className="field-label">Precio máximo</label>
                        <input
                            className="field-input"
                            type="number"
                            min={0}
                            step="0.01"
                            value={form.price_max}
                            onChange={e => set('price_max', e.target.value)}
                            placeholder="150"
                        />
                    </div>
                </div>

                <div className="service-form-row">
                    <div className="field">
                        <label className="field-label">Duración (minutos)</label>
                        <input
                            className="field-input"
                            type="number"
                            min={1}
                            value={form.duration_min}
                            onChange={e => set('duration_min', e.target.value)}
                            placeholder="45"
                        />
                    </div>
                    <div className="field">
                        <label className="field-label">Categoría</label>
                        <input
                            className="field-input"
                            value={form.category}
                            onChange={e => set('category', e.target.value)}
                            placeholder="Ej: Facial, Corporal, Láser..."
                        />
                    </div>
                </div>

                <div className="service-form-actions">
                    <button className="btn-secondary" onClick={onCancel} disabled={saving}>
                        Cancelar
                    </button>
                    <button
                        className="btn-save"
                        onClick={onSave}
                        disabled={saving || !form.name.trim()}
                    >
                        {saving ? 'Guardando...' : isNew ? 'Crear servicio' : 'Guardar cambios'}
                    </button>
                </div>
            </div>
        </section>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ServiciosPage() {
    const { companyId } = useParams<{ companyId: string }>();

    const [services, setServices] = useState<Service[]>([]);
    const [loading, setLoading] = useState(true);

    // UI state
    const [editingId, setEditingId] = useState<string | null>(null); // 'new' = creating
    const [form, setForm] = useState<FormData>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

    // ── Fetch ──────────────────────────────────────────────────────────────────

    async function fetchServices() {
        try {
            const res = await fetch(`/api/admin/${companyId}/servicios?archived=true`);
            const data = await res.json();
            setServices(Array.isArray(data) ? data : []);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        fetchServices();
    }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Toast ──────────────────────────────────────────────────────────────────

    function showToast(type: 'ok' | 'err', msg: string) {
        setToast({ type, msg });
        setTimeout(() => setToast(null), 3000);
    }

    // ── CRUD ───────────────────────────────────────────────────────────────────

    function startAdd() {
        setEditingId('new');
        setForm(EMPTY_FORM);
        setArchiveConfirmId(null);
    }

    function startEdit(s: Service) {
        setEditingId(s.id);
        setForm(serviceToForm(s));
        setArchiveConfirmId(null);
    }

    function cancelEdit() {
        setEditingId(null);
        setForm(EMPTY_FORM);
    }

    async function save() {
        if (!form.name.trim() || saving) return;
        setSaving(true);
        try {
            const body = formToBody(form);

            if (editingId === 'new') {
                const res = await fetch(`/api/admin/${companyId}/servicios`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error((await res.json()).error ?? 'Error al crear');
                showToast('ok', 'Servicio creado');
            } else {
                const res = await fetch(`/api/admin/${companyId}/servicios`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: editingId, ...body }),
                });
                if (!res.ok) throw new Error((await res.json()).error ?? 'Error al guardar');
                showToast('ok', 'Servicio actualizado');
            }

            setEditingId(null);
            setForm(EMPTY_FORM);
            await fetchServices();
        } catch (err: any) {
            showToast('err', err.message || 'Error inesperado');
        } finally {
            setSaving(false);
        }
    }

    async function archiveService(id: string) {
        try {
            const res = await fetch(`/api/admin/${companyId}/servicios`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, active: false }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? 'Error al archivar');
            setArchiveConfirmId(null);
            showToast('ok', 'Servicio archivado');
            await fetchServices();
        } catch (err: any) {
            showToast('err', err.message || 'Error al archivar');
        }
    }

    async function restoreService(id: string) {
        try {
            const res = await fetch(`/api/admin/${companyId}/servicios`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, active: true }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? 'Error al restaurar');
            showToast('ok', 'Servicio restaurado');
            await fetchServices();
        } catch (err: any) {
            showToast('err', err.message || 'Error al restaurar');
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="agente-loading">
                <div className="agente-spinner" />
                <p>Cargando servicios...</p>
            </div>
        );
    }

    const active = services.filter(s => s.active);
    const archived = services.filter(s => !s.active);

    return (
        <div className="servicios-page">

            {/* ── Top bar ──────────────────────────────────────────────── */}
            <div className="servicios-topbar">
                <div>
                    <h1 className="servicios-title">Servicios</h1>
                    <p className="servicios-subtitle">
                        {active.length === 0
                            ? 'Agrega los tratamientos que ofrece tu clínica'
                            : `${active.length} servicio${active.length !== 1 ? 's' : ''} activo${active.length !== 1 ? 's' : ''}`}
                    </p>
                </div>
                <div className="servicios-topbar-actions">
                    {toast && (
                        <span className={`save-status save-status--${toast.type}`}>
                            {toast.msg}
                        </span>
                    )}
                    <button
                        className="btn-save"
                        onClick={startAdd}
                        disabled={editingId === 'new'}
                    >
                        + Nuevo servicio
                    </button>
                </div>
            </div>

            {/* ── New service form ─────────────────────────────────────── */}
            {editingId === 'new' && (
                <ServiceForm
                    form={form}
                    onChange={setForm}
                    onSave={save}
                    onCancel={cancelEdit}
                    saving={saving}
                    isNew
                />
            )}

            {/* ── Service list ─────────────────────────────────────────── */}
            {active.length === 0 && editingId !== 'new' ? (
                <section className="admin-card">
                    <div className="card-body">
                        <div className="empty-state">
                            <p className="empty-state-title">Sin servicios registrados</p>
                            <p className="empty-state-desc">
                                Agrega los tratamientos y servicios que ofrece tu clínica.<br />
                                El agente IA los usará para informar y agendar citas.
                            </p>
                            <button className="btn-save" onClick={startAdd}>
                                + Agregar primer servicio
                            </button>
                        </div>
                    </div>
                </section>
            ) : (
                <div className="servicios-list">
                    {active.map(s =>
                        editingId === s.id ? (
                            <ServiceForm
                                key={s.id}
                                form={form}
                                onChange={setForm}
                                onSave={save}
                                onCancel={cancelEdit}
                                saving={saving}
                                isNew={false}
                            />
                        ) : (
                            <div key={s.id} className="service-card">
                                <div className="service-card-main">
                                    <div className="service-card-info">
                                        <h3 className="service-name">{s.name}</h3>
                                        {s.description && (
                                            <p className="service-desc">{s.description}</p>
                                        )}
                                        <div className="service-badges">
                                            {formatPrice(s) && (
                                                <span className="service-badge service-badge--price">
                                                    {formatPrice(s)}
                                                </span>
                                            )}
                                            {formatDuration(s.duration_min) && (
                                                <span className="service-badge service-badge--duration">
                                                    {formatDuration(s.duration_min)}
                                                </span>
                                            )}
                                            {s.category && (
                                                <span className="service-badge service-badge--category">
                                                    {s.category}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="service-card-actions">
                                        <button
                                            className="service-action-btn"
                                            onClick={() => startEdit(s)}
                                            title="Editar"
                                        >
                                            ✎
                                        </button>
                                        <button
                                            className="service-action-btn service-action-btn--archive"
                                            onClick={() => setArchiveConfirmId(s.id)}
                                            title="Archivar"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>

                                {archiveConfirmId === s.id && (
                                    <div className="archive-confirm">
                                        <span>¿Archivar <strong>{s.name}</strong>? No se eliminará.</span>
                                        <div className="archive-confirm-actions">
                                            <button
                                                className="btn-secondary"
                                                onClick={() => setArchiveConfirmId(null)}
                                            >
                                                Cancelar
                                            </button>
                                            <button
                                                className="archive-confirm-btn"
                                                onClick={() => archiveService(s.id)}
                                            >
                                                Sí, archivar
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    )}
                </div>
            )}

            {/* ── Archived section ─────────────────────────────────────── */}
            {archived.length > 0 && (
                <div className="archived-section">
                    <button
                        className="archived-toggle"
                        onClick={() => setShowArchived(!showArchived)}
                    >
                        {showArchived ? '▾' : '▸'} Archivados ({archived.length})
                    </button>

                    {showArchived && (
                        <div className="servicios-list">
                            {archived.map(s => (
                                <div key={s.id} className="service-card service-card--archived">
                                    <div className="service-card-main">
                                        <div className="service-card-info">
                                            <h3 className="service-name">{s.name}</h3>
                                            {s.description && (
                                                <p className="service-desc">{s.description}</p>
                                            )}
                                        </div>
                                        <button
                                            className="btn-secondary"
                                            onClick={() => restoreService(s.id)}
                                        >
                                            Restaurar
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
