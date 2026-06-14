// =============================================================================
// WOBBLE SIGNAL — Latest Facebook Page post / Reel
// Public read-only endpoint for the Wobblekins Hostinger homepage.
//
// Required Vercel environment variables:
//   FACEBOOK_PAGE_ID
//   FACEBOOK_PAGE_ACCESS_TOKEN
//
// Optional:
//   FACEBOOK_GRAPH_VERSION=v25.0
//   FACEBOOK_PAGE_URL=https://www.facebook.com/your-page
//   WOBBLE_SIGNAL_CACHE_SECONDS=300
// =============================================================================

const ALLOWED_ORIGINS = [
  'https://wobblekins.com',
  'https://www.wobblekins.com'
];

const DEFAULT_GRAPH_VERSION = 'v25.0';
const DEFAULT_CACHE_SECONDS = 300;
const GRAPH_TIMEOUT_MS = 9000;

function setCors(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function cleanText(value, maxLength = 900) {
  if (typeof value !== 'string') return '';

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function safeDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function mediaImage(attachment) {
  return (
    attachment?.media?.image?.src ||
    attachment?.subattachments?.data?.[0]?.media?.image?.src ||
    null
  );
}

function classifyFromUrl(url, fallback = 'video') {
  const normalized = String(url || '').toLowerCase();

  if (normalized.includes('/reel/') || normalized.includes('/reels/')) {
    return 'reel';
  }

  return fallback;
}

function normalizePost(post) {
  const attachment = post?.attachments?.data?.[0] || null;
  const attachmentType = String(attachment?.type || '').toLowerCase();
  const permalink = post?.permalink_url || attachment?.url || attachment?.target?.url || '';

  let kind = 'status';

  if (
    attachmentType.includes('video') ||
    attachmentType.includes('reel') ||
    String(permalink).toLowerCase().includes('/reel')
  ) {
    kind = classifyFromUrl(permalink, 'video');
  } else if (
    attachmentType.includes('photo') ||
    attachmentType.includes('image') ||
    post?.full_picture ||
    mediaImage(attachment)
  ) {
    kind = 'image';
  } else if (attachmentType.includes('link')) {
    kind = 'link';
  }

  return {
    id: String(post?.id || ''),
    kind,
    message: cleanText(
      post?.message || attachment?.description || attachment?.title || ''
    ),
    image_url: post?.full_picture || mediaImage(attachment),
    permalink_url: permalink || null,
    created_time: safeDate(post?.created_time)
  };
}

function normalizeVideo(video, forcedKind = null) {
  const permalink = video?.permalink_url || '';

  return {
    id: String(video?.id || ''),
    kind: forcedKind || classifyFromUrl(permalink, 'video'),
    message: cleanText(video?.description || video?.title || ''),
    image_url: video?.picture || null,
    permalink_url: permalink || null,
    created_time: safeDate(video?.created_time)
  };
}

function labelForKind(kind) {
  switch (kind) {
    case 'reel':
      return 'LATEST REEL';
    case 'video':
      return 'LATEST VIDEO';
    case 'image':
      return 'LATEST SIGHTING';
    case 'link':
      return 'LATEST TRANSMISSION';
    default:
      return 'LATEST LAB NOTE';
  }
}

function itemScore(item) {
  return Date.parse(item?.created_time || '') || 0;
}

function uniqueItems(items) {
  const seen = new Set();

  return items.filter((item) => {
    if (!item?.created_time) return false;

    const key = item.permalink_url || item.id;
    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function createGraphUrl({ version, pageId, edge, fields, token, limit = 8 }) {
  const url = new URL(`https://graph.facebook.com/${version}/${pageId}/${edge}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('access_token', token);
  return url;
}

async function fetchGraph(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload?.error) {
      const graphMessage = payload?.error?.message || `Meta request failed (${response.status})`;
      throw new Error(graphMessage);
    }

    return Array.isArray(payload?.data) ? payload.data : [];
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const pageId = String(process.env.FACEBOOK_PAGE_ID || '').trim();
  const pageAccessToken = String(process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
  const graphVersion = String(
    process.env.FACEBOOK_GRAPH_VERSION || DEFAULT_GRAPH_VERSION
  ).trim();
  const pageUrl = String(process.env.FACEBOOK_PAGE_URL || '').trim() || null;

  const configuredCacheSeconds = Number.parseInt(
    process.env.WOBBLE_SIGNAL_CACHE_SECONDS || '',
    10
  );
  const cacheSeconds = Number.isFinite(configuredCacheSeconds)
    ? Math.min(Math.max(configuredCacheSeconds, 60), 3600)
    : DEFAULT_CACHE_SECONDS;

  if (!pageId || !pageAccessToken) {
    console.error('[wobble-signal] Missing FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN');
    return res.status(503).json({
      ok: false,
      error: 'Wobble Signal is not configured yet.',
      page_url: pageUrl
    });
  }

  const postFields = [
    'id',
    'message',
    'created_time',
    'permalink_url',
    'full_picture',
    'attachments.limit(1){type,url,title,description,media,target,subattachments.limit(1){type,url,media,target}}'
  ].join(',');

  const videoFields = [
    'id',
    'title',
    'description',
    'created_time',
    'permalink_url',
    'picture'
  ].join(',');

  const requests = [
    {
      name: 'posts',
      url: createGraphUrl({
        version: graphVersion,
        pageId,
        edge: 'posts',
        fields: postFields,
        token: pageAccessToken
      })
    },
    {
      name: 'videos',
      url: createGraphUrl({
        version: graphVersion,
        pageId,
        edge: 'videos',
        fields: videoFields,
        token: pageAccessToken
      })
    },
    {
      // Meta exposes GET /{page-id}/video_reels. Some Page/app combinations
      // may not return this edge; failure is intentionally non-fatal because
      // Reels also commonly appear through Page posts/videos.
      name: 'reels',
      url: createGraphUrl({
        version: graphVersion,
        pageId,
        edge: 'video_reels',
        fields: videoFields,
        token: pageAccessToken
      })
    }
  ];

  try {
    const settled = await Promise.allSettled(
      requests.map(async (request) => ({
        name: request.name,
        data: await fetchGraph(request.url)
      }))
    );

    const items = [];
    const failedEdges = [];

    settled.forEach((result, index) => {
      const name = requests[index].name;

      if (result.status === 'rejected') {
        failedEdges.push(name);
        console.warn(`[wobble-signal] ${name} edge failed:`, result.reason?.message || result.reason);
        return;
      }

      if (name === 'posts') {
        items.push(...result.value.data.map(normalizePost));
      } else if (name === 'reels') {
        items.push(...result.value.data.map((item) => normalizeVideo(item, 'reel')));
      } else {
        items.push(...result.value.data.map((item) => normalizeVideo(item)));
      }
    });

    const newest = uniqueItems(items).sort((a, b) => itemScore(b) - itemScore(a))[0] || null;

    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 6}`
    );

    if (!newest) {
      return res.status(404).json({
        ok: false,
        error: 'No public Wobble Signal is available yet.',
        page_url: pageUrl
      });
    }

    return res.status(200).json({
      ok: true,
      source: 'facebook',
      page_url: pageUrl,
      item: {
        ...newest,
        label: labelForKind(newest.kind)
      },
      fetched_at: new Date().toISOString(),
      partial: failedEdges.length > 0
    });
  } catch (error) {
    console.error('[wobble-signal] Unexpected error:', error);

    return res.status(502).json({
      ok: false,
      error: 'The Wobble Signal could not be received right now.',
      page_url: pageUrl
    });
  }
}
