import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import SpotifyClient, { TokenStore } from './spotify';

const app = express();
app.use(express.json());
const PORT = parseInt(process.env.PORT || '8888', 10);

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const REDIRECT_URI =
  process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SCOPES = [
  'user-read-recently-played',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-top-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-follow-read',
  'user-read-private',
  'user-read-email',
].join(' ');

// ── Token Management ──

const TOKEN_FILE = path.join(__dirname, 'data', 'tokens.json');

interface TokenData {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number;
}

function loadTokens(): TokenData {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as TokenData;
    }
  } catch {}
  return { access_token: null, refresh_token: null, expires_at: 0 };
}

function saveTokens(store: TokenData): void {
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({
      access_token: store.access_token,
      refresh_token: store.refresh_token,
      expires_at: store.expires_at,
    }),
  );
}

const _saved = loadTokens();
const tokenStore: TokenData & TokenStore = {
  access_token: _saved.access_token,
  refresh_token: _saved.refresh_token,
  expires_at: _saved.expires_at,

  async getAccessToken(): Promise<string> {
    if (!this.refresh_token)
      throw new Error('Not authenticated. Visit /login first.');
    if (Date.now() >= this.expires_at - 60000) {
      return this.refresh();
    }
    return this.access_token!;
  },

  async refresh(): Promise<string> {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refresh_token!,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    this.access_token = response.data.access_token;
    this.expires_at = Date.now() + response.data.expires_in * 1000;
    saveTokens(this);
    return this.access_token!;
  },
} as TokenData & TokenStore & { refresh(): Promise<string> };

const spotify = new SpotifyClient(tokenStore);

// Helper: save JSON data to disk
function saveData(filename: string, data: unknown): string {
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Saved ${filepath} (${JSON.stringify(data).length} bytes)`);
  return filepath;
}

// ── Auth Routes ──

app.get('/login', (req: Request, res: Response) => {
  // Clear existing tokens to force fresh auth
  tokenStore.access_token = null;
  tokenStore.refresh_token = null;
  tokenStore.expires_at = 0;

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: 'true', // force consent screen
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req: Request, res: Response) => {
  const { code, error } = req.query as { code?: string; error?: string };
  if (error) return void res.send(`Authorization failed: ${error}`);

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    tokenStore.access_token = response.data.access_token;
    tokenStore.refresh_token = response.data.refresh_token;
    tokenStore.expires_at = Date.now() + response.data.expires_in * 1000;
    saveTokens(tokenStore);

    console.log('Authenticated successfully!');
    res.redirect('/');
  } catch (err) {
    console.error('Token exchange failed:', (err as AxiosError).response?.data || (err as Error).message);
    res.status(500).send('Token exchange failed. Check terminal for details.');
  }
});

// ── Middleware: check auth ──
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!tokenStore.refresh_token) {
    res.status(401).json({ error: 'Not authenticated. Visit /login first.' });
    return;
  }
  next();
}

// ── Helper: read cached data from disk ──
function readCached(filename: string): any {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

// ── Auth check (no Spotify call, just checks token state) ──
app.get('/api/auth-status', (req: Request, res: Response) => {
  res.json({ authenticated: !!tokenStore.refresh_token });
});

// ── Data Endpoints (serve from cache, no Spotify API calls) ──

app.get('/api/profile', requireAuth, (req: Request, res: Response) => {
  const data = readCached('profile.json');
  if (!data) return void res.json({ display_name: 'User', images: [] });
  res.json(data);
});

app.get('/api/recently-played', requireAuth, (req: Request, res: Response) => {
  const data = readCached('recently_played.json');
  if (!data)
    return void res
      .status(404)
      .json({ error: 'No data yet. Click Collect All Data first.' });
  res.json({ count: data.items?.length || 0, data });
});

app.get('/api/current-playback', requireAuth, (req: Request, res: Response) => {
  const data = readCached('current_playback.json');
  res.json(data || { message: 'Nothing currently playing' });
});

app.get('/api/top-tracks', requireAuth, (req: Request, res: Response) => {
  const shortTerm = readCached('top_tracks_short.json') || [];
  const mediumTerm = readCached('top_tracks_medium.json') || [];
  const longTerm = readCached('top_tracks_long.json') || [];

  const data = {
    short_term: {
      period: 'Last 4 weeks',
      count: shortTerm.length,
      tracks: shortTerm,
    },
    medium_term: {
      period: 'Last 6 months',
      count: mediumTerm.length,
      tracks: mediumTerm,
    },
    long_term: { period: 'All time', count: longTerm.length, tracks: longTerm },
  };

  res.json({
    short_term: data.short_term.count,
    medium_term: data.medium_term.count,
    long_term: data.long_term.count,
    data,
  });
});

app.get('/api/top-artists', requireAuth, (req: Request, res: Response) => {
  const shortTerm = readCached('top_artists_short.json') || [];
  const mediumTerm = readCached('top_artists_medium.json') || [];
  const longTerm = readCached('top_artists_long.json') || [];

  const data = {
    short_term: {
      period: 'Last 4 weeks',
      count: shortTerm.length,
      artists: shortTerm,
    },
    medium_term: {
      period: 'Last 6 months',
      count: mediumTerm.length,
      artists: mediumTerm,
    },
    long_term: {
      period: 'All time',
      count: longTerm.length,
      artists: longTerm,
    },
  };

  res.json({
    short_term: data.short_term.count,
    medium_term: data.medium_term.count,
    long_term: data.long_term.count,
    data,
  });
});

app.get('/api/saved-tracks', requireAuth, (req: Request, res: Response) => {
  const tracks = readCached('saved_tracks.json') || [];
  res.json({ count: tracks.length, tracks });
});

app.get('/api/saved-albums', requireAuth, (req: Request, res: Response) => {
  const albums = readCached('saved_albums.json') || [];
  res.json({ count: albums.length, albums });
});

app.get('/api/playlists', requireAuth, (req: Request, res: Response) => {
  const playlists = readCached('playlists.json') || [];
  res.json({ count: playlists.length, playlists });
});

app.get('/api/followed-artists', requireAuth, (req: Request, res: Response) => {
  const artists = readCached('followed_artists.json') || [];
  res.json({ count: artists.length, artists });
});

// Listening stats derived from collected data
app.get('/api/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const recentData = readCached('recently_played.json');
    const recentItems: any[] = recentData?.items || [];
    const totalRecentMs = recentItems.reduce(
      (sum: number, item: any) => sum + (item.track?.duration_ms || 0),
      0,
    );

    const topTracksShort: any[] = readCached('top_tracks_short.json') || [];
    const topTracksMedium: any[] = readCached('top_tracks_medium.json') || [];
    const topTracksLong: any[] = readCached('top_tracks_long.json') || [];
    const topArtistsShort: any[] = readCached('top_artists_short.json') || [];
    const savedTracks: any[] = readCached('saved_tracks.json') || [];
    const playlists: any[] = readCached('playlists.json') || [];
    const followedArtists: any[] = readCached('followed_artists.json') || [];

    const avgPopularity =
      topArtistsShort.length > 0
        ? Math.round(
            topArtistsShort.reduce((s: number, a: any) => s + (a.popularity || 0), 0) /
              topArtistsShort.length,
          )
        : 0;

    const genreCounts: Record<string, number> = {};
    topArtistsShort.forEach((a: any) =>
      (a.genres || []).forEach((g: string) => {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      }),
    );
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([genre, count]) => ({ genre, count }));

    const trackPlayCounts: Record<string, { track: any; count: number }> = {};
    recentItems.forEach((item: any) => {
      const t = item.track;
      if (!t) return;
      if (!trackPlayCounts[t.id]) trackPlayCounts[t.id] = { track: t, count: 0 };
      trackPlayCounts[t.id].count++;
    });
    const repeats = Object.values(trackPlayCounts)
      .filter((r) => r.count > 1)
      .sort((a, b) => b.count - a.count);

    const hourBuckets: number[] = Array(24).fill(0);
    recentItems.forEach((item: any) => {
      if (item.played_at) {
        const hour = new Date(item.played_at).getHours();
        hourBuckets[hour]++;
      }
    });

    const decadeCounts: Record<string, number> = {};
    [...topTracksShort, ...topTracksMedium, ...topTracksLong].forEach((t: any) => {
      const year = t.album?.release_date?.substring(0, 4);
      if (year) {
        const decade = `${Math.floor(parseInt(year) / 10) * 10}s`;
        decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;
      }
    });

    const stats = {
      overview: {
        recent_listening_minutes: Math.round(totalRecentMs / 60000),
        top_tracks_short: topTracksShort.length,
        top_tracks_medium: topTracksMedium.length,
        top_tracks_long: topTracksLong.length,
        top_artists_short: topArtistsShort.length,
        saved_tracks: savedTracks.length,
        playlists: playlists.length,
        followed_artists: followedArtists.length,
        avg_artist_popularity: avgPopularity,
      },
      top_genres: topGenres,
      repeat_tracks: repeats.map((r) => ({
        name: r.track.name,
        artist: r.track.artists?.map((a: any) => a.name).join(', '),
        plays: r.count,
        image: r.track.album?.images?.[2]?.url,
      })),
      listening_by_hour: hourBuckets,
      decade_breakdown: decadeCounts,
    };

    saveData('stats.json', stats);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Per-tab refresh endpoints (fetch fresh data from Spotify) ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.post('/api/refresh/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await spotify.getProfile();
    saveData('profile.json', profile);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/recently-played', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await spotify.getRecentlyPlayed(50);
    saveData('recently_played.json', data);
    res.json({ count: data.items.length, data });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/top-tracks', requireAuth, async (req: Request, res: Response) => {
  try {
    const short = await spotify.getTopTracks('short_term');
    saveData('top_tracks_short.json', short);
    await delay(1000);
    const medium = await spotify.getTopTracks('medium_term');
    saveData('top_tracks_medium.json', medium);
    await delay(1000);
    const long = await spotify.getTopTracks('long_term');
    saveData('top_tracks_long.json', long);

    const data = {
      short_term: {
        period: 'Last 4 weeks',
        count: short.length,
        tracks: short,
      },
      medium_term: {
        period: 'Last 6 months',
        count: medium.length,
        tracks: medium,
      },
      long_term: { period: 'All time', count: long.length, tracks: long },
    };
    res.json({
      short_term: short.length,
      medium_term: medium.length,
      long_term: long.length,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/top-artists', requireAuth, async (req: Request, res: Response) => {
  try {
    const short = await spotify.getTopArtists('short_term');
    saveData('top_artists_short.json', short);
    await delay(1000);
    const medium = await spotify.getTopArtists('medium_term');
    saveData('top_artists_medium.json', medium);
    await delay(1000);
    const long = await spotify.getTopArtists('long_term');
    saveData('top_artists_long.json', long);

    const data = {
      short_term: {
        period: 'Last 4 weeks',
        count: short.length,
        artists: short,
      },
      medium_term: {
        period: 'Last 6 months',
        count: medium.length,
        artists: medium,
      },
      long_term: { period: 'All time', count: long.length, artists: long },
    };
    res.json({
      short_term: short.length,
      medium_term: medium.length,
      long_term: long.length,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/saved-tracks', requireAuth, async (req: Request, res: Response) => {
  try {
    const tracks = await spotify.getSavedTracks(10);
    saveData('saved_tracks.json', tracks);
    res.json({ count: tracks.length, tracks });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/saved-albums', requireAuth, async (req: Request, res: Response) => {
  try {
    const albums = await spotify.getSavedAlbums(5);
    saveData('saved_albums.json', albums);
    res.json({ count: albums.length, albums });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/refresh/playlists', requireAuth, async (req: Request, res: Response) => {
  try {
    const playlists = await spotify.getPlaylists(5);
    saveData('playlists.json', playlists);
    res.json({ count: playlists.length, playlists });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Listening Profile ──
// Replaces the 1-9 scoring system with two continuous scores per artist:
//   heatScore  (0-1) — how much you're listening RIGHT NOW (On Repeat signal)
//   rewindScore (0-1) — how much you USED TO listen, but don't now (Repeat Rewind signal)

const readJson = (file: string): any => {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
};

interface ArtistEntry {
  id: string;
  name: string;
  image: string | null;
  genres: string[];
  shortRanks: number[];
  mediumRanks: number[];
  longRanks: number[];
  recentPlays: number;
}

function computeListeningProfile(): { artists: any[]; updatedAt: number } {
  const shortTracks: any[] = readJson('top_tracks_short.json') || [];
  const mediumTracks: any[] = readJson('top_tracks_medium.json') || [];
  const longTracks: any[] = readJson('top_tracks_long.json') || [];
  const shortArtists: any[] = readJson('top_artists_short.json') || [];
  const mediumArtists: any[] = readJson('top_artists_medium.json') || [];
  const longArtists: any[] = readJson('top_artists_long.json') || [];
  const recentItems: any[] = readJson('recently_played.json')?.items || [];

  const N_SHORT = Math.max(shortTracks.length, 1);
  const N_MEDIUM = Math.max(mediumTracks.length, 1);
  const N_LONG = Math.max(longTracks.length, 1);

  // Recent play counts per artist from recently_played
  const recentPlaysByArtist: Record<string, number> = {};
  recentItems.forEach((item: any) => {
    (item.track?.artists || []).forEach((a: any) => {
      recentPlaysByArtist[a.id] = (recentPlaysByArtist[a.id] || 0) + 1;
    });
  });
  const maxRecentPlays = Math.max(...Object.values(recentPlaysByArtist), 1);

  // Accumulate per-artist rank lists across all timeframes
  const artistMap: Record<string, ArtistEntry> = {};
  function addTrack(track: any, pos: number, timeframe: 'short' | 'medium' | 'long') {
    (track.artists || []).forEach((a: any) => {
      if (!artistMap[a.id]) {
        artistMap[a.id] = {
          id: a.id,
          name: a.name,
          image: null,
          genres: [],
          shortRanks: [],
          mediumRanks: [],
          longRanks: [],
          recentPlays: recentPlaysByArtist[a.id] || 0,
        };
      }
      artistMap[a.id][`${timeframe}Ranks`].push(pos);
      if (!artistMap[a.id].image) {
        artistMap[a.id].image =
          track.album?.images?.[1]?.url ||
          track.album?.images?.[0]?.url ||
          null;
      }
    });
  }
  shortTracks.forEach((t: any, i: number) => addTrack(t, i, 'short'));
  mediumTracks.forEach((t: any, i: number) => addTrack(t, i, 'medium'));
  longTracks.forEach((t: any, i: number) => addTrack(t, i, 'long'));

  // Enrich images and genres from top-artist lists
  [...shortArtists, ...mediumArtists, ...longArtists].forEach((a: any) => {
    if (artistMap[a.id]) {
      if (!artistMap[a.id].image)
        artistMap[a.id].image =
          a.images?.[1]?.url || a.images?.[0]?.url || null;
      if (!artistMap[a.id].genres?.length)
        artistMap[a.id].genres = a.genres || [];
    }
  });

  const artists = Object.values(artistMap).map((a) => {
    // heatScore: driven by short-term rank + recent plays
    const shortScore =
      a.shortRanks.length > 0
        ? Math.max(...a.shortRanks.map((r) => (N_SHORT - r) / N_SHORT))
        : 0;
    const recentScore = a.recentPlays / maxRecentPlays;
    const heatScore = shortScore * 0.65 + recentScore * 0.35;

    // rewindScore: strong past presence that has decayed from current listening
    const mediumScore =
      a.mediumRanks.length > 0
        ? Math.max(...a.mediumRanks.map((r) => (N_MEDIUM - r) / N_MEDIUM))
        : 0;
    const longScore =
      a.longRanks.length > 0
        ? Math.max(...a.longRanks.map((r) => (N_LONG - r) / N_LONG))
        : 0;
    const pastScore = Math.max(mediumScore, longScore);
    // High past score × low current presence = high rewind
    const rewindScore = pastScore * (1 - shortScore * 0.7);

    return {
      id: a.id,
      name: a.name,
      image: a.image,
      genres: a.genres,
      recentPlays: a.recentPlays,
      heatScore: +heatScore.toFixed(3),
      rewindScore: +rewindScore.toFixed(3),
      shortTracks: a.shortRanks.length,
      mediumTracks: a.mediumRanks.length,
      longTracks: a.longRanks.length,
    };
  });

  // Only include artists with any signal; sort hottest first
  const active = artists.filter((a) => a.heatScore > 0 || a.rewindScore > 0);
  active.sort((a, b) => b.heatScore - a.heatScore);

  return { artists: active, updatedAt: Date.now() };
}

app.get('/api/affinity', requireAuth, (req: Request, res: Response) => {
  const cached = readCached('affinity.json');
  if (!cached)
    return void res
      .status(404)
      .json({ error: 'No profile data. Click Compute first.' });
  res.json(cached);
});

app.post('/api/refresh/affinity', requireAuth, (req: Request, res: Response) => {
  try {
    const result = computeListeningProfile();
    saveData('affinity.json', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Excluded Artists ──

app.get('/api/excluded-artists', requireAuth, (req: Request, res: Response) => {
  res.json(readCached('excluded_artists.json') || []);
});

app.post('/api/excluded-artists', requireAuth, (req: Request, res: Response) => {
  const ids = req.body || [];
  saveData('excluded_artists.json', ids);
  res.json(ids);
});

// ── Playlist Generator ──

function pickWeighted(items: any[], weights: number[]): any {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

interface SelectTracksOptions {
  size: number;
  mode?: 'on_repeat' | 'mixed' | 'repeat_rewind';
  randomness?: number;
  excludeArtists: string[];
}

interface SelectTracksResult {
  tracks: any[];
  timeframeCounts: { short: number; medium: number; long: number };
  breakdown: { artist: string; count: number }[];
}

// Shared track selection logic for both preview and generate.
//
// mode: 'on_repeat' | 'mixed' | 'repeat_rewind' — controls which timeframe pool to draw from
// randomness: 0–100
//   0   = strict rank order (top-ranked tracks always win)
//   50  = weighted random (higher-ranked tracks more likely but not guaranteed)
//   100 = fully random from the eligible pool
//
// Track rank is the primary driver. Artist is not a filter — any track in the
// top-tracks lists is eligible, and top artists naturally appear more because
// they have more ranked tracks.
function selectTracks({ size, mode = 'mixed', randomness = 30, excludeArtists }: SelectTracksOptions): SelectTracksResult {
  const excludeSet = new Set(excludeArtists);
  const r = Math.max(0, Math.min(100, randomness)) / 100; // normalize to 0–1

  const shortTracks: any[] = readJson('top_tracks_short.json') || [];
  const mediumTracks: any[] = readJson('top_tracks_medium.json') || [];
  const longTracks: any[] = readJson('top_tracks_long.json') || [];
  const shortIds = new Set(shortTracks.map((t) => t.id));

  // Artists present in short-term — used to filter medium/long in mixed mode
  // so we only get extra songs from artists you currently listen to, not random old ones
  const shortArtistIds = new Set(
    shortTracks.flatMap((t) => (t.artists || []).map((a: any) => a.id)),
  );

  // Per-track recent play count — boosts tracks you've actually been playing lately
  const recentPlaysByTrack: Record<string, number> = {};
  const recentItems: any[] = readJson('recently_played.json')?.items || [];
  recentItems.forEach((item: any) => {
    const id = item.track?.id;
    if (id) recentPlaysByTrack[id] = (recentPlaysByTrack[id] || 0) + 1;
  });
  const maxRecentPlays = Math.max(...Object.values(recentPlaysByTrack), 1);

  const trackMap = new Map<string, any>();
  shortTracks.forEach((t: any, i: number) => {
    if (!trackMap.has(t.id))
      trackMap.set(t.id, { ...t, timeframe: 'short', position: i });
  });
  // For mixed/on_repeat: only include medium/long tracks from artists already in short-term
  // For repeat_rewind: include everything (the goal is surfacing old artists)
  mediumTracks.forEach((t: any, i: number) => {
    if (trackMap.has(t.id)) return;
    const artistId = t.artists?.[0]?.id;
    if (mode !== 'repeat_rewind' && !shortArtistIds.has(artistId)) return;
    trackMap.set(t.id, { ...t, timeframe: 'medium', position: i });
  });
  longTracks.forEach((t: any, i: number) => {
    if (trackMap.has(t.id)) return;
    const artistId = t.artists?.[0]?.id;
    if (mode !== 'repeat_rewind' && !shortArtistIds.has(artistId)) return;
    trackMap.set(t.id, { ...t, timeframe: 'long', position: i });
  });

  function getArtistId(track: any): string | null {
    return track.artists?.[0]?.id || null;
  }

  function timeframeWeight(track: any): number {
    if (mode === 'on_repeat') {
      return track.timeframe === 'short' ? 1.0
        : track.timeframe === 'medium' ? 0.2
        : 0.03;
    }
    if (mode === 'repeat_rewind') {
      if (shortIds.has(track.id)) return 0.03;
      return track.timeframe === 'long' ? 1.0 : 0.85;
    }
    // mixed: short-term always wins, medium/long are bonus tracks from known artists
    return track.timeframe === 'short' ? 1.0
      : track.timeframe === 'medium' ? 0.4
      : 0.15;
  }

  function computeWeight(track: any): number {
    const artistId = getArtistId(track);
    if (artistId && excludeSet.has(artistId)) return 0;

    const tf = timeframeWeight(track);
    if (tf === 0) return 0;

    // Rank-based weight: rank 1 → 1.0, rank 50 → ~0.18 (logarithmic falloff)
    const rankWeight = 1 / Math.log2(2 + track.position);

    // Recent plays boost: tracks played recently get up to 2× the rank weight
    const recentBoost = 1 + (recentPlaysByTrack[track.id] || 0) / maxRecentPlays;

    // Base score combining rank + recency
    const baseScore = rankWeight * recentBoost * tf;

    // Randomness blends rank-driven weight toward uniform:
    // r=0 → pure baseScore, r=1 → every track equally likely
    return baseScore * (1 - r) + 1.0 * r;
  }

  const selectedTracks: any[] = [];
  const timeframeCounts = { short: 0, medium: 0, long: 0 };
  const usedTrackIds = new Set<string>();

  function pickFrom(pool: any[]): any {
    const available = pool.filter((t) => !usedTrackIds.has(t.id));
    if (available.length === 0) return null;
    const weights = available.map((t) => computeWeight(t));
    if (weights.every((w) => w === 0)) return null;
    const track = pickWeighted(available, weights);
    if (!track) return null;
    usedTrackIds.add(track.id);
    selectedTracks.push(track);
    timeframeCounts[track.timeframe as 'short' | 'medium' | 'long']++;
    return track;
  }

  const allTracks = Array.from(trackMap.values());
  while (selectedTracks.length < size) {
    if (!pickFrom(allTracks)) break;
  }

  // Shuffle so order doesn't reflect selection order
  for (let i = selectedTracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [selectedTracks[i], selectedTracks[j]] = [
      selectedTracks[j],
      selectedTracks[i],
    ];
  }

  const artistPickCounts: Record<string, number> = {};
  selectedTracks.forEach((track) => {
    if (track.artists?.length > 0) {
      const artistName = track.artists[0].name;
      artistPickCounts[artistName] = (artistPickCounts[artistName] || 0) + 1;
    }
  });
  const breakdown = Object.entries(artistPickCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([artist, count]) => ({ artist, count }));

  return { tracks: selectedTracks, timeframeCounts, breakdown };
}

app.post('/api/preview-playlist', requireAuth, (req: Request, res: Response) => {
  try {
    const { size = 30, mode = 'mixed', randomness = 30, excludeArtists = [] } = req.body || {};
    const { tracks, timeframeCounts, breakdown } = selectTracks({ size, mode, randomness, excludeArtists });
    res.json({ tracks, timeframeCounts, breakdown });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate-playlist', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      size = 30,
      name = 'My Mix',
      mode = 'mixed',
      randomness = 30,
      excludeArtists = [],
    } = req.body || {};

    const { tracks: selectedTracks, timeframeCounts, breakdown } = selectTracks(
      { size, mode, randomness, excludeArtists },
    );

    const description = `Affinity Mix — ${selectedTracks.length} tracks (${timeframeCounts.short} recent / ${timeframeCounts.medium} mid / ${timeframeCounts.long} deep cuts)`;
    const playlist = await spotify.createPlaylist(name, description);
    console.log('Playlist created:', playlist.id, playlist.name);
    console.log('Adding', selectedTracks.length, 'tracks...');
    await spotify.addTracksToPlaylist(
      playlist.id,
      selectedTracks.map((t) => t.uri),
    );
    console.log('Tracks added successfully');

    const result = {
      playlist: {
        id: playlist.id,
        name: playlist.name,
        url: playlist.external_urls?.spotify,
        tracks: selectedTracks.length,
      },
      timeframeCounts,
      breakdown,
    };

    saveData('last_generated_playlist.json', result);
    res.json(result);
  } catch (err) {
    console.error(
      'Playlist generation failed:',
      (err as AxiosError).response?.data || (err as Error).message,
    );
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Top Tracks Playlist (strict 70/20/10 split, no overlap) ──

interface SelectTopTracksOptions {
  size?: number;
  excludeArtists?: string[];
  excludeAlbums?: string[];
}

function selectTopTracksPlaylist({ size = 30, excludeArtists = [], excludeAlbums = [] }: SelectTopTracksOptions): SelectTracksResult {
  const excludeSet = new Set(excludeArtists);
  const excludeAlbumSet = new Set(excludeAlbums);

  const shortTracks: any[] = readJson('top_tracks_short.json') || [];
  const mediumTracks: any[] = readJson('top_tracks_medium.json') || [];
  const longTracks: any[] = readJson('top_tracks_long.json') || [];

  function filterExcluded(tracks: any[]): any[] {
    return tracks.filter((t) => {
      if ((t.artists || []).some((a: any) => excludeSet.has(a.id))) return false;
      if (t.album?.id && excludeAlbumSet.has(t.album.id)) return false;
      return true;
    });
  }

  const short = filterExcluded(shortTracks).slice(0, 200);
  const shortIds = new Set(short.map((t) => t.id));

  const medium = filterExcluded(mediumTracks).slice(0, 200).filter((t) => !shortIds.has(t.id));
  const mediumIds = new Set(medium.map((t) => t.id));

  const long = filterExcluded(longTracks).slice(0, 200).filter(
    (t) => !shortIds.has(t.id) && !mediumIds.has(t.id),
  );

  const shortCount = Math.round(size * 0.7);
  const mediumCount = Math.round(size * 0.2);
  const longCount = size - shortCount - mediumCount;

  function shufflePick(arr: any[], n: number): any[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length));
  }

  const picked = [
    ...shufflePick(short, shortCount).map((t) => ({ ...t, timeframe: 'short' })),
    ...shufflePick(medium, mediumCount).map((t) => ({ ...t, timeframe: 'medium' })),
    ...shufflePick(long, longCount).map((t) => ({ ...t, timeframe: 'long' })),
  ];

  // Shuffle final list
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }

  const timeframeCounts = {
    short: picked.filter((t) => t.timeframe === 'short').length,
    medium: picked.filter((t) => t.timeframe === 'medium').length,
    long: picked.filter((t) => t.timeframe === 'long').length,
  };

  const artistPickCounts: Record<string, number> = {};
  picked.forEach((track) => {
    const name = track.artists?.[0]?.name;
    if (name) artistPickCounts[name] = (artistPickCounts[name] || 0) + 1;
  });
  const breakdown = Object.entries(artistPickCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([artist, count]) => ({ artist, count }));

  return { tracks: picked, timeframeCounts, breakdown };
}

app.post('/api/preview-top-tracks-playlist', requireAuth, (req: Request, res: Response) => {
  try {
    const { size = 30, excludeArtists = [], excludeAlbums = [] } = req.body || {};
    const result = selectTopTracksPlaylist({ size, excludeArtists, excludeAlbums });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/recommendations-for-playlist', requireAuth, async (req: Request, res: Response) => {
  try {
    const { trackIds = [], count = 5, excludeArtists = [], excludeAlbums = [], existingTrackIds = [] } = req.body || {};
    const excludeSet = new Set<string>(excludeArtists);
    const excludeAlbumSet = new Set<string>(excludeAlbums);
    const existingSet = new Set<string>(existingTrackIds);

    const seeds = (trackIds as string[]).slice(0, 5);
    if (seeds.length === 0) return void res.json({ tracks: [] });

    const recData = await spotify.getRecommendations({
      seedTracks: seeds,
      limit: Math.min(count * 3, 100),
    });

    const filtered = (recData.tracks || [])
      .filter((t: any) => {
        if (existingSet.has(t.id)) return false;
        if ((t.artists || []).some((a: any) => excludeSet.has(a.id))) return false;
        if (t.album?.id && excludeAlbumSet.has(t.album.id)) return false;
        return true;
      })
      .slice(0, count);

    res.json({ tracks: filtered });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/api/generate-top-tracks-playlist', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      name = 'My Top Tracks Mix',
      trackUris = [],
      timeframeCounts = {},
      breakdown = [],
    } = req.body || {};

    const tf = timeframeCounts as { short?: number; medium?: number; long?: number };
    const description = `Top Tracks Mix — ${(trackUris as string[]).length} tracks (${tf.short || 0} recent / ${tf.medium || 0} mid / ${tf.long || 0} deep cuts)`;
    const playlist = await spotify.createPlaylist(name, description);
    await spotify.addTracksToPlaylist(playlist.id, trackUris as string[]);

    const result = {
      playlist: {
        id: playlist.id,
        name: playlist.name,
        url: playlist.external_urls?.spotify,
        tracks: (trackUris as string[]).length,
      },
      timeframeCounts,
      breakdown,
    };

    saveData('last_generated_top_tracks_playlist.json', result);
    res.json(result);
  } catch (err) {
    console.error('Top tracks playlist generation failed:', (err as AxiosError).response?.data || (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Serve static frontend ──
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
  console.log(`Login at http://127.0.0.1:${PORT}/login`);
});
