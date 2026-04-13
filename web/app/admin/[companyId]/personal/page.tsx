'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GCalConfig {
    calendar_id: string;
    work_start: string;
    work_end: string;
    work_days: number[];
    default_slot_min: number;
}

interface StaffMember {
    id: string;
    name: string;
    role: string | null;
    specialty: string | null;
    phone: string | null;
    email: string | null;
    max_daily_appointments: number | null;
    active: boolean;
    gcal_email: string | null;
    gcal_connected_at: string | null;
    gcal_config: GCalConfig | null;
}

interface StaffFormData {
    name: string;
    role: string;
    specialty: string;
    phone: string;
    email: string;
    max_daily_appointments: string;
}

const EMPTY_FORM: StaffFormData = {
    name: '',
    role: '',
    specialty: '',
    phone: '',
    email: '',
    max_daily_appointments: '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function formatWorkDays(days: number[]): string {
    if (!days || days.length === 0) return '';
    const sorted = [...days].sort();
    if (sorted.length === 5 && sorted[0] === 1 && sorted[4] === 5) return 'Lun-Vie';
    if (sorted.length === 6 && sorted[0] === 1 && sorted[5] === 6) return 'Lun-Sáb';
    if (sorted.length === 7) return 'Todos';
    return sorted.map(d => DAY_NAMES[d] ?? d).join(', ');
}

function staffToForm(s: StaffMember): StaffFormData {
    return {
        name: s.name,
        role: s.role ?? '',
        specialty: s.specialty ?? '',
        phone: s.phone ?? '',
        email: s.email ?? '',
        max_daily_appointments: s.max_daily_appointments != null ? String(s.max_daily_appointments) : '',
    };
}

function formToBody(f: StaffFormData) {
    return {
        name: f.name.trim(),
        role: f.role.trim() || null,
        specialty: f.specialty.trim() || null,
        phone: f.phone.trim() || null,
        email: f.email.trim() || null,
        max_daily_appointments: f.max_daily_appointments ? Number(f.max_daily_appointments) : null,
    };
}

// ─── Staff Form ───────────────────────────────────────────────────────────────

function StaffForm({
    form,
    onChange,
    onSave,
    onCancel,
    saving,
    isNew,
}: {
    form: StaffFormData;
    onChange: (f: StaffFormData) => void;
    onSave: () => void;
    onCancel: () => void;
    saving: boolean;
    isNew: boolean;
}) {
    function set(key: keyof StaffFormData, val: string) {
        onChange({ ...form, [key]: val });
    }

    return (
        <section className="admin-card">
            <div className="card-header">
                <span className="card-header-icon">{isNew ? '✦' : '✎'}</span>
                <div>
                    <h2 className="card-title">{isNew ? 'Nuevo profesional' : 'Editar profesional'}</h2>
                    <p className="card-subtitle">
                        {isNew
                            ? 'Agrega un miembro del equipo a tu clínica'
                            : 'Modifica los datos de este profesional'}
                    </p>
                </div>
            </div>
            <div className="card-body">
                <div className="field">
                    <label className="field-label">Nombre *</label>
                    <input
                        className="field-input"
                        value={form.name}
                        onChange={e => set('name', e.target.value)}
                        placeholder="Ej: Dra. García, Dr. López..."
                        autoFocus
                    />
                </div>

                <div className="staff-form-row">
                    <div className="field">
                        <label className="field-label">Rol</label>
                        <input
                            className="field-input"
                            value={form.role}
                            onChange={e => set('role', e.target.value)}
                            placeholder="Ej: Médico, Esteticista, Asesora..."
                        />
                    </div>
                    <div className="field">
                        <label className="field-label">Especialidad</label>
                        <input
                            className="field-input"
                            value={form.specialty}
                            onChange={e => set('specialty', e.target.value)}
                            placeholder="Ej: Medicina Estética, Dermatología..."
                        />
                    </div>
                </div>

                <div className="staff-form-row">
                    <div className="field">
                        <label className="field-label">Teléfono</label>
                        <input
                            className="field-input"
                            value={form.phone}
                            onChange={e => set('phone', e.target.value)}
                            placeholder="Ej: +57 300 123 4567"
                        />
                    </div>
                    <div className="field">
                        <label className="field-label">Email</label>
                        <input
                            className="field-input"
                            type="email"
                            value={form.email}
                            onChange={e => set('email', e.target.value)}
                            placeholder="Ej: dra.garcia@clinica.com"
                        />
                    </div>
                </div>

                <div className="staff-form-row">
                    <div className="field">
                        <label className="field-label">Máx. citas diarias</label>
                        <input
                            className="field-input"
                            type="number"
                            min={1}
                            value={form.max_daily_appointments}
                            onChange={e => set('max_daily_appointments', e.target.value)}
                            placeholder="8"
                        />
                    </div>
                    <div className="field" />
                </div>

                <div className="staff-form-actions">
                    <button className="btn-secondary" onClick={onCancel} disabled={saving}>
                        Cancelar
                    </button>
                    <button
                        className="btn-save"
                        onClick={onSave}
                        disabled={saving || !form.name.trim()}
                    >
                        {saving ? 'Guardando...' : isNew ? 'Crear profesional' : 'Guardar cambios'}
                    </button>
                </div>
            </div>
        </section>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PersonalPage() {
    const { companyId } = useParams<{ companyId: string }>();

    const [staff, setStaff] = useState<StaffMember[]>([]);
    const [loading, setLoading] = useState(true);

    // UI state
    const [editingId, setEditingId] = useState<string | null>(null); // 'new' = creating
    const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

    // ── Fetch ──────────────────────────────────────────────────────────────────

    async function fetchStaff() {
        try {
            const res = await fetch(`/api/admin/${companyId}/staff?archived=true`);
            const data = await res.json();
            setStaff(Array.isArray(data) ? data : []);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        fetchStaff();
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

    function startEdit(s: StaffMember) {
        setEditingId(s.id);
        setForm(staffToForm(s));
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
                const res = await fetch(`/api/admin/${companyId}/staff`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) throw new Error((await res.json()).error ?? 'Error al crear');
                showToast('ok', 'Profesional creado');
            } else {
                const res = await fetch(`/api/admin/${companyId}/staff`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: editingId, ...body }),
                });
                if (!res.ok) throw new Error((await res.json()).error ?? 'Error al guardar');
                showToast('ok', 'Profesional actualizado');
            }

            setEditingId(null);
            setForm(EMPTY_FORM);
            await fetchStaff();
        } catch (err: any) {
            showToast('err', err.message || 'Error inesperado');
        } finally {
            setSaving(false);
        }
    }

    async function archiveStaff(id: string) {
        try {
            const res = await fetch(`/api/admin/${companyId}/staff`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, active: false }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? 'Error al archivar');
            setArchiveConfirmId(null);
            showToast('ok', 'Profesional archivado');
            await fetchStaff();
        } catch (err: any) {
            showToast('err', err.message || 'Error al archivar');
        }
    }

    async function restoreStaff(id: string) {
        try {
            const res = await fetch(`/api/admin/${companyId}/staff`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, active: true }),
            });
            if (!res.ok) throw new Error((await res.json()).error ?? 'Error al restaurar');
            showToast('ok', 'Profesional restaurado');
            await fetchStaff();
        } catch (err: any) {
            showToast('err', err.message || 'Error al restaurar');
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="agente-loading">
                <div className="agente-spinner" />
                <p>Cargando personal...</p>
            </div>
        );
    }

    const active = staff.filter(s => s.active);
    const archived = staff.filter(s => !s.active);

    return (
        <div className="personal-page">

            {/* ── Top bar ──────────────────────────────────────────────── */}
            <div className="personal-topbar">
                <div>
                    <h1 className="personal-title">Personal</h1>
                    <p className="personal-subtitle">
                        {active.length === 0
                            ? 'Agrega los profesionales que trabajan en tu clínica'
                            : `${active.length} profesional${active.length !== 1 ? 'es' : ''} activo${active.length !== 1 ? 's' : ''}`}
                    </p>
                </div>
                <div className="personal-topbar-actions">
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
                        + Nuevo profesional
                    </button>
                </div>
            </div>

            {/* ── New staff form ───────────────────────────────────────── */}
            {editingId === 'new' && (
                <StaffForm
                    form={form}
                    onChange={setForm}
                    onSave={save}
                    onCancel={cancelEdit}
                    saving={saving}
                    isNew
                />
            )}

            {/* ── Staff list ──────────────────────────────────────────── */}
            {active.length === 0 && editingId !== 'new' ? (
                <section className="admin-card">
                    <div className="card-body">
                        <div className="empty-state">
                            <p className="empty-state-title">Sin personal registrado</p>
                            <p className="empty-state-desc">
                                Agrega los profesionales que trabajan en tu clínica.<br />
                                El agente IA los usará para asignar citas.
                            </p>
                            <button className="btn-save" onClick={startAdd}>
                                + Agregar primer profesional
                            </button>
                        </div>
                    </div>
                </section>
            ) : (
                <div className="personal-list">
                    {active.map(s =>
                        editingId === s.id ? (
                            <StaffForm
                                key={s.id}
                                form={form}
                                onChange={setForm}
                                onSave={save}
                                onCancel={cancelEdit}
                                saving={saving}
                                isNew={false}
                            />
                        ) : (
                            <div key={s.id} className="staff-card">
                                <div className="staff-card-main">
                                    <div className="staff-card-info">
                                        <h3 className="staff-card-name">{s.name}</h3>
                                        {(s.phone || s.email) && (
                                            <p className="staff-card-detail">
                                                {s.phone}{s.phone && s.email ? ' · ' : ''}{s.email}
                                            </p>
                                        )}
                                        <div className="staff-badges">
                                            {s.role && (
                                                <span className="staff-badge staff-badge--role">
                                                    {s.role}
                                                </span>
                                            )}
                                            {s.specialty && (
                                                <span className="staff-badge staff-badge--specialty">
                                                    {s.specialty}
                                                </span>
                                            )}
                                            {s.max_daily_appointments && (
                                                <span className="staff-badge staff-badge--appointments">
                                                    Máx. {s.max_daily_appointments} citas/día
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="staff-card-actions">
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

                                {/* ── GCal status ──────────────────────────── */}
                                <div className="staff-gcal-section">
                                    <span className={`staff-gcal-dot staff-gcal-dot--${s.gcal_email ? 'connected' : 'disconnected'}`} />
                                    <span className="staff-gcal-label">
                                        {s.gcal_email ? 'Google Calendar conectado' : 'Sin Google Calendar'}
                                    </span>
                                    {s.gcal_email && (
                                        <span className="staff-gcal-email">{s.gcal_email}</span>
                                    )}
                                    {s.gcal_config && (
                                        <div className="staff-gcal-config">
                                            <span>{s.gcal_config.work_start} – {s.gcal_config.work_end}</span>
                                            <span>{formatWorkDays(s.gcal_config.work_days)}</span>
                                            <span>{s.gcal_config.default_slot_min} min/slot</span>
                                        </div>
                                    )}
                                </div>

                                {archiveConfirmId === s.id && (
                                    <div className="archive-confirm">
                                        <span>¿Archivar a <strong>{s.name}</strong>? No se eliminará.</span>
                                        <div className="archive-confirm-actions">
                                            <button
                                                className="btn-secondary"
                                                onClick={() => setArchiveConfirmId(null)}
                                            >
                                                Cancelar
                                            </button>
                                            <button
                                                className="archive-confirm-btn"
                                                onClick={() => archiveStaff(s.id)}
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

            {/* ── Archived section ────────────────────────────────────── */}
            {archived.length > 0 && (
                <div className="archived-section">
                    <button
                        className="archived-toggle"
                        onClick={() => setShowArchived(!showArchived)}
                    >
                        {showArchived ? '▾' : '▸'} Archivados ({archived.length})
                    </button>

                    {showArchived && (
                        <div className="personal-list">
                            {archived.map(s => (
                                <div key={s.id} className="staff-card staff-card--archived">
                                    <div className="staff-card-main">
                                        <div className="staff-card-info">
                                            <h3 className="staff-card-name">{s.name}</h3>
                                            {(s.phone || s.email) && (
                                                <p className="staff-card-detail">
                                                    {s.phone}{s.phone && s.email ? ' · ' : ''}{s.email}
                                                </p>
                                            )}
                                        </div>
                                        <button
                                            className="btn-secondary"
                                            onClick={() => restoreStaff(s.id)}
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
