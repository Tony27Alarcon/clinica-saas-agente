import { createClient } from '@supabase/supabase-js';
import Link from 'next/link';
import { Epilogue, Outfit } from 'next/font/google';

const epilogue = Epilogue({
    subsets: ['latin'],
    weight: ['500', '700', '800'],
    variable: '--font-epilogue',
    display: 'swap',
});

const outfit = Outfit({
    subsets: ['latin'],
    weight: ['400', '500', '600'],
    variable: '--font-outfit',
    display: 'swap',
});

async function getCompany(companyId: string) {
    const { data } = await (createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!,
        { auth: { persistSession: false } }
    ) as any)
        .schema('clinicas')
        .from('companies')
        .select('name, plan')
        .eq('id', companyId)
        .maybeSingle();
    return data as { name: string; plan: string } | null;
}

export default async function AdminLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ companyId: string }>;
}) {
    const { companyId } = await params;
    const company = await getCompany(companyId);

    return (
        <div className={`admin-shell ${epilogue.variable} ${outfit.variable}`}>
            <aside className="admin-sidebar">
                {/* Brand */}
                <div className="admin-brand">
                    <span className="admin-brand-icon">✨</span>
                    <span className="admin-brand-name">Bruno Lab</span>
                </div>

                {/* Clinic info */}
                {company && (
                    <div className="admin-clinic-block">
                        <span className="admin-clinic-label">Clínica</span>
                        <span className="admin-clinic-name">{company.name}</span>
                        <span className={`admin-plan-badge admin-plan-${company.plan}`}>
                            {company.plan}
                        </span>
                    </div>
                )}

                {/* Nav */}
                <nav className="admin-nav">
                    <span className="admin-nav-section-label">Configuración</span>
                    <Link
                        href={`/admin/${companyId}/agente`}
                        className="admin-nav-item"
                    >
                        <span className="admin-nav-icon">🤖</span>
                        Agente IA
                    </Link>
                    <Link
                        href={`/admin/${companyId}/servicios`}
                        className="admin-nav-item"
                    >
                        <span className="admin-nav-icon">💆</span>
                        Servicios
                    </Link>
                    <Link
                        href={`/admin/${companyId}/personal`}
                        className="admin-nav-item"
                    >
                        <span className="admin-nav-icon">👥</span>
                        Personal
                    </Link>
                </nav>
            </aside>

            <main className="admin-main">
                {children}
            </main>
        </div>
    );
}
