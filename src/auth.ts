import { getServerSession, type NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { getAuthUserStore } from '@/server/auth/userStore';

const LOCAL_DEVELOPMENT_AUTH_SECRET = 'openclaw-local-nextauth-secret';

function resolveNextAuthSecret(): string {
  const nextAuthSecret = process.env.NEXTAUTH_SECRET?.trim();
  if (nextAuthSecret) {
    return nextAuthSecret;
  }

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (authSecret) {
    return authSecret;
  }

  return LOCAL_DEVELOPMENT_AUTH_SECRET;
}

export const authOptions: NextAuthOptions = {
  secret: resolveNextAuthSecret(),
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      name: 'Local Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = String(credentials?.email || '')
          .trim()
          .toLowerCase();
        const password = String(credentials?.password || '');

        if (!email || !password) {
          return null;
        }

        const user = getAuthUserStore().verifyCredentials(email, password);
        if (!user) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user && typeof user.id === 'string') {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.id === 'string') {
        session.user.id = token.id;
      }
      return session;
    },
  },
};

export function auth() {
  return getServerSession(authOptions);
}
