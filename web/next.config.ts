import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // El frontend solo necesita las variables de Supabase para lectura
    env: {
        NEXT_PUBLIC_APP_NAME: 'Bruno Lab',
    },
};

export default nextConfig;
