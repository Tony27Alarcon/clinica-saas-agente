import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'MedAgent · Portal de Clínica',
    description: 'Panel de información pública de la clínica',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="es">
            <body>{children}</body>
        </html>
    );
}
