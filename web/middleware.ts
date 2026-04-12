import { jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';

const COOKIE  = 'admin_session';
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 h

function secret() {
    const raw = process.env.INTERNAL_API_SECRET?.trim();
    if (!raw) throw new Error('INTERNAL_API_SECRET no está configurado');
    return new TextEncoder().encode(raw);
}

async function verify(token: string): Promise<{ companyId: string } | null> {
    try {
        const { payload } = await jwtVerify(token, secret());
        return payload as { companyId: string };
    } catch {
        return null;
    }
}

export async function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;

    // ── Extraer companyId de la URL (/admin/[companyId]/...) ────────────────
    const match = pathname.match(/^\/admin\/([^/]+)/);
    const urlCompanyId = match?.[1];

    const urlToken = req.nextUrl.searchParams.get('token');

    // ── Flujo magic link: token en la URL ───────────────────────────────────
    if (urlToken) {
        const payload = await verify(urlToken);

        if (!payload || payload.companyId !== urlCompanyId) {
            return NextResponse.redirect(new URL('/admin/auth-error', req.url));
        }

        // Token válido: guardar en cookie HttpOnly y limpiar la URL
        const cleanUrl = req.nextUrl.clone();
        cleanUrl.searchParams.delete('token');
        const res = NextResponse.redirect(cleanUrl);
        res.cookies.set(COOKIE, urlToken, {
            httpOnly: true,
            secure:   true,
            sameSite: 'lax',
            maxAge:   COOKIE_MAX_AGE,
            path:     '/',
        });
        return res;
    }

    // ── Flujo sesión activa: cookie existente ────────────────────────────────
    const cookieToken = req.cookies.get(COOKIE)?.value;

    if (!cookieToken) {
        return NextResponse.redirect(new URL('/admin/auth-error', req.url));
    }

    const payload = await verify(cookieToken);

    if (!payload) {
        // Expirada o inválida: limpiar cookie y redirigir
        const res = NextResponse.redirect(new URL('/admin/auth-error', req.url));
        res.cookies.delete(COOKIE);
        return res;
    }

    if (urlCompanyId && payload.companyId !== urlCompanyId) {
        // El token no corresponde a esta clínica
        return NextResponse.redirect(new URL('/admin/auth-error', req.url));
    }

    return NextResponse.next();
}

export const config = {
    matcher: ['/admin/((?!auth-error).*)'],
};
