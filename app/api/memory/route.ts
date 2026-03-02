import {
  handleMemoryDelete,
  handleMemoryGet,
  handleMemoryPatch,
  handleMemoryPost,
  handleMemoryPut,
} from '@/server/memory/api';
import { withUserContext } from '../_shared/withUserContext';

export const runtime = 'nodejs';

export const GET = withUserContext(async ({ request, userContext }) =>
  handleMemoryGet(request, userContext),
);

export const POST = withUserContext(async ({ request, userContext }) =>
  handleMemoryPost(request, userContext),
);

export const PUT = withUserContext(async ({ request, userContext }) =>
  handleMemoryPut(request, userContext),
);

export const DELETE = withUserContext(async ({ request, userContext }) =>
  handleMemoryDelete(request, userContext),
);

export const PATCH = withUserContext(async ({ request, userContext }) =>
  handleMemoryPatch(request, userContext),
);
