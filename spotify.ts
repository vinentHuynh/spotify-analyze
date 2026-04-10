import axios, { AxiosError } from 'axios';

const API_BASE = 'https://api.spotify.com/v1';

export interface TokenStore {
  getAccessToken(): Promise<string>;
}

class SpotifyClient {
  private tokenStore: TokenStore;

  constructor(tokenStore: TokenStore) {
    this.tokenStore = tokenStore;
  }

  async request(endpoint: string, params: Record<string, unknown> = {}, retries = 3): Promise<any> {
    const token = await this.tokenStore.getAccessToken();
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: { Authorization: `Bearer ${token}` },
          params,
        });
        return response.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        if (axiosErr.response?.status === 429 && attempt < retries - 1) {
          const retryAfter = Math.min(
            parseInt((axiosErr.response.headers['retry-after'] as string) || '2', 10),
            10,
          );
          console.log(`Rate limited, waiting ${retryAfter}s before retry...`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          throw err;
        }
      }
    }
  }

  // Paginate through all results for endpoints that support it
  async fetchAll(endpoint: string, params: Record<string, unknown> = {}, limit = 50): Promise<any[]> {
    const items: any[] = [];
    let url: string | null = `${API_BASE}${endpoint}`;
    let requestParams: Record<string, unknown> = { ...params, limit };

    while (url) {
      const data = await this.request(url, requestParams);
      items.push(...(data.items || []));
      url = data.next || null;
      requestParams = {}; // next URL includes params already
    }

    return items;
  }

  // ── User Profile ──
  async getProfile(): Promise<any> {
    return this.request('/me');
  }

  // ── Recently Played ──
  // Max 50 per request, supports `after` cursor for polling
  async getRecentlyPlayed(limit = 50, after?: number): Promise<any> {
    const params: Record<string, unknown> = { limit };
    if (after) params.after = after;
    return this.request('/me/player/recently-played', params);
  }

  // ── Currently Playing ──
  async getCurrentPlayback(): Promise<any> {
    try {
      return await this.request('/me/player');
    } catch (err) {
      if ((err as AxiosError).response?.status === 204) return null; // nothing playing
      throw err;
    }
  }

  // ── Top Items ──
  async getTopTracks(timeRange = 'medium_term', limit = 50): Promise<any[]> {
    return this.fetchAll('/me/top/tracks', { time_range: timeRange }, limit);
  }

  async getTopArtists(timeRange = 'medium_term', limit = 50): Promise<any[]> {
    return this.fetchAll('/me/top/artists', { time_range: timeRange }, limit);
  }

  // ── Library ──
  async getSavedTracks(maxPages = 10): Promise<any[]> {
    const items: any[] = [];
    let url: string | null = `${API_BASE}/me/tracks`;
    let params: Record<string, unknown> = { limit: 50 };
    let page = 0;

    while (url && page < maxPages) {
      const data = await this.request(url, params);
      items.push(...(data.items || []));
      url = data.next || null;
      params = {};
      page++;
    }

    return items;
  }

  async getSavedAlbums(maxPages = 5): Promise<any[]> {
    const items: any[] = [];
    let url: string | null = `${API_BASE}/me/albums`;
    let params: Record<string, unknown> = { limit: 50 };
    let page = 0;

    while (url && page < maxPages) {
      const data = await this.request(url, params);
      items.push(...(data.items || []));
      url = data.next || null;
      params = {};
      page++;
    }

    return items;
  }

  // ── Playlists ──
  async getPlaylists(maxPages = 5): Promise<any[]> {
    const items: any[] = [];
    let url: string | null = `${API_BASE}/me/playlists`;
    let params: Record<string, unknown> = { limit: 50 };
    let page = 0;

    while (url && page < maxPages) {
      const data = await this.request(url, params);
      items.push(...(data.items || []));
      url = data.next || null;
      params = {};
      page++;
    }

    return items;
  }

  async getPlaylistTracks(playlistId: string, maxPages = 5): Promise<any[]> {
    const items: any[] = [];
    let url: string | null = `${API_BASE}/playlists/${playlistId}/items`;
    let params: Record<string, unknown> = { limit: 100 };
    let page = 0;

    while (url && page < maxPages) {
      const data = await this.request(url, params);
      items.push(...(data.items || []));
      url = data.next || null;
      params = {};
      page++;
    }

    return items;
  }

  // ── Audio Features (batch up to 100 track IDs) ──
  async getAudioFeatures(trackIds: string[]): Promise<any[]> {
    const features: any[] = [];
    for (let i = 0; i < trackIds.length; i += 100) {
      const batch = trackIds.slice(i, i + 100);
      const data = await this.request('/audio-features', { ids: batch.join(',') });
      features.push(...(data.audio_features || []).filter(Boolean));
    }
    return features;
  }

  // ── Artist Details (one at a time — batch /artists removed Feb 2026) ──
  async getArtist(artistId: string): Promise<any> {
    return this.request(`/artists/${artistId}`);
  }

  // ── Recommendations ──
  async getRecommendations({
    seedTracks = [],
    seedArtists = [],
    seedGenres = [],
    ...tuning
  }: {
    seedTracks?: string[];
    seedArtists?: string[];
    seedGenres?: string[];
    [key: string]: unknown;
  } = {}): Promise<any> {
    return this.request('/recommendations', {
      seed_tracks: seedTracks.join(','),
      seed_artists: seedArtists.join(','),
      seed_genres: seedGenres.join(','),
      limit: 100,
      ...tuning,
    });
  }

  // ── Create Playlist ──
  async createPlaylist(name: string, description = '', isPublic = false): Promise<any> {
    const token = await this.tokenStore.getAccessToken();
    const response = await axios.post(
      `${API_BASE}/me/playlists`,
      { name, description, public: isPublic },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );
    return response.data;
  }

  async addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
    const token = await this.tokenStore.getAccessToken();
    // Max 100 items per request — uses /items endpoint (Feb 2026 API change)
    for (let i = 0; i < trackUris.length; i += 100) {
      const batch = trackUris.slice(i, i + 100);
      await axios.post(
        `${API_BASE}/playlists/${playlistId}/items`,
        { uris: batch },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );
    }
  }
}

export default SpotifyClient;
