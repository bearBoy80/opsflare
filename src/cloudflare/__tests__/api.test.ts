import {
  CloudflareApiError,
  createR2Bucket,
  deleteKvKeys,
  deleteR2Object,
  deleteR2Objects,
  getActiveWorkerVersion,
  getKvEntries,
  putKvValue,
  getPagesPreviewSetting,
  getWorkerSubdomainConfig,
  getR2ManagedDomain,
  getZoneSecurityLevel,
  getZoneSslMode,
  setZoneSecurityLevel,
  listAccounts,
  listD1Databases,
  listDnsRecords,
  updateDnsRecord,
  listKvNamespaces,
  listPagesDomains,
  listPagesProjects,
  listR2Buckets,
  listWorkerScripts,
  listWorkerVersions,
  listAlertHistory,
  listAuditLogs,
  listLoadBalancerPools,
  listLoadBalancers,
  listZoneLoadBalancers,
  listRumSites,
  listSubscriptions,
  listZones,
  resetLegacyListOptions,
  rollbackPagesDeployment,
  rollbackWorkerVersion,
  setPagesPreviewSetting,
  setR2ManagedDomain,
  setWorkerSubdomainConfig,
  verifyToken,
} from '../api';

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  resetLegacyListOptions();
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

const jsonResponse = (body: unknown, status = 200) => ({
  status,
  json: async () => body,
});

describe('verifyToken', () => {
  test('returns the token id for an active token', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { id: 'tok-1', status: 'active' },
      }),
    );

    await expect(verifyToken('  secret  ')).resolves.toEqual({
      id: 'tok-1',
      status: 'active',
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
    );
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  test('rejects tokens that are not active', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { id: 'tok-1', status: 'disabled' },
      }),
    );

    await expect(verifyToken('secret')).rejects.toMatchObject({
      code: 'invalid-token',
    });
  });

  test('maps 401 responses to invalid-token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401));

    await expect(verifyToken('bad')).rejects.toMatchObject({
      code: 'invalid-token',
    });
  });

  test('maps fetch failures to network errors', async () => {
    mockFetch.mockRejectedValue(new TypeError('offline'));

    await expect(verifyToken('secret')).rejects.toMatchObject({
      code: 'network',
    });
  });

  test('surfaces Cloudflare error messages', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: false,
        errors: [{ code: 9109, message: 'Invalid access token' }],
        result: null,
      }),
    );

    await expect(verifyToken('secret')).rejects.toThrow(
      'Invalid access token',
    );
  });

  test('maps Authentication error 10000 to forbidden without the raw message', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          result: null,
        },
        403,
      ),
    );

    await expect(listAlertHistory('secret', 'acc-1')).rejects.toMatchObject({
      code: 'forbidden',
      serverMessage: undefined,
    });
  });
});

describe('listAccounts', () => {
  test('returns id/name pairs', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          { id: 'acc-1', name: 'Acme Corp', type: 'standard' },
          { id: 'acc-2', name: 'Side Project', type: 'standard' },
        ],
      }),
    );

    await expect(listAccounts('secret')).resolves.toEqual([
      { id: 'acc-1', name: 'Acme Corp' },
      { id: 'acc-2', name: 'Side Project' },
    ]);
  });

  test('propagates CloudflareApiError instances', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    });

    await expect(listAccounts('secret')).rejects.toBeInstanceOf(
      CloudflareApiError,
    );
  });
});

describe('listZones', () => {
  test('maps the zone payload to a flat shape', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'zone-1',
            name: 'acme.com',
            status: 'active',
            paused: false,
            plan: { name: 'Enterprise' },
            account: { id: 'acc-1', name: 'Acme Corp' },
            name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
          },
          {
            id: 'zone-2',
            name: 'bare.dev',
            status: 'pending',
          },
        ],
      }),
    );

    await expect(listZones('secret')).resolves.toEqual([
      {
        id: 'zone-1',
        name: 'acme.com',
        status: 'active',
        paused: false,
        plan: 'Enterprise',
        accountId: 'acc-1',
        accountName: 'Acme Corp',
        nameServers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
      },
      {
        id: 'zone-2',
        name: 'bare.dev',
        status: 'pending',
        paused: false,
        plan: 'Free',
        accountId: '',
        accountName: '',
        nameServers: [],
      },
    ]);
  });

  test('walks every page instead of stopping at the first 50', async () => {
    // An account with more zones than one page holds: without pagination the
    // Zones tab would silently show only the first page, and the search over
    // it filters an already-truncated list.
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'zone-1', name: 'a.com', status: 'active' }],
          result_info: { total_count: 3, per_page: 1 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'zone-2', name: 'b.com', status: 'active' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'zone-3', name: 'c.com', status: 'active' }],
        }),
      );

    const zones = await listZones('secret');

    expect(zones.map((zone) => zone.id)).toEqual([
      'zone-1',
      'zone-2',
      'zone-3',
    ]);
    expect(mockFetch.mock.calls[0][0]).toContain('/zones?page=1&per_page=50');
    expect(mockFetch.mock.calls[1][0]).toContain('/zones?page=2&per_page=50');
    expect(mockFetch.mock.calls[2][0]).toContain('/zones?page=3&per_page=50');
  });

  test('stops after one request when the first page is the only one', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [{ id: 'zone-1', name: 'a.com', status: 'active' }],
        result_info: { total_count: 1, per_page: 50 },
      }),
    );

    await listZones('secret');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('listDnsRecords', () => {
  test('walks every page so the list matches the zone record count', async () => {
    // The zone overview shows `countDnsRecords` (the true total), so a list
    // capped at one page would contradict the number the user just saw and
    // leave the remaining records unreachable.
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'rec-1', type: 'A', name: 'a.acme.com' }],
          result_info: { total_count: 2, per_page: 1 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [
            {
              id: 'rec-2',
              type: 'CNAME',
              name: 'www.acme.com',
              content: 'acme.com',
              proxied: true,
              ttl: 300,
            },
          ],
        }),
      );

    await expect(listDnsRecords('secret', 'zone-1')).resolves.toEqual([
      {
        id: 'rec-1',
        type: 'A',
        name: 'a.acme.com',
        content: '',
        proxied: false,
        ttl: 1,
      },
      {
        id: 'rec-2',
        type: 'CNAME',
        name: 'www.acme.com',
        content: 'acme.com',
        proxied: true,
        ttl: 300,
      },
    ]);
    expect(mockFetch.mock.calls[0][0]).toContain(
      '/zones/zone-1/dns_records?page=1&per_page=100',
    );
    expect(mockFetch.mock.calls[1][0]).toContain(
      '/zones/zone-1/dns_records?page=2&per_page=100',
    );
  });
});

describe('DNS record priority and updates', () => {
  test('carries the MX priority through the list', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'rec-mx',
            type: 'MX',
            name: 'acme.com',
            content: 'mx2.mail.com',
            priority: 20,
          },
        ],
        result_info: { total_pages: 1 },
      }),
    );

    const [record] = await listDnsRecords('secret', 'zone-1');
    expect(record.priority).toBe(20);
  });

  test('edits with PATCH so comment and tags are not overwritten', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { id: 'rec-1' } }),
    );

    await updateDnsRecord('secret', 'zone-1', 'rec-1', {
      type: 'A',
      name: 'a.acme.com',
      content: '192.0.2.1',
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/rec-1',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).not.toHaveProperty('comment');
  });
});

describe('getZoneSslMode', () => {
  test('returns the ssl setting value', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { id: 'ssl', value: 'strict' },
      }),
    );

    await expect(getZoneSslMode('secret', 'zone-1')).resolves.toBe('strict');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/settings/ssl',
    );
  });
});

describe('listRumSites', () => {
  test('maps Web Analytics sites', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            site_tag: 'site-1',
            ruleset: { zone_tag: 'zone-1', zone_name: 'acme.com' },
            rules: [{ host: 'www.acme.com' }],
          },
        ],
      }),
    );

    await expect(listRumSites('secret', 'acc-1')).resolves.toEqual([
      {
        siteTag: 'site-1',
        zoneId: 'zone-1',
        zoneName: 'acme.com',
        hosts: ['www.acme.com'],
      },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/rum/site_info/list?page=1',
    );
  });
});

describe('zone security level', () => {
  test('reads the current security level', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { id: 'security_level', value: 'medium' },
      }),
    );

    await expect(getZoneSecurityLevel('secret', 'zone-1')).resolves.toBe(
      'medium',
    );
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/settings/security_level',
    );
  });

  test('patches under_attack mode', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { id: 'security_level', value: 'under_attack' },
      }),
    );

    await setZoneSecurityLevel('secret', 'zone-1', 'under_attack');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/settings/security_level',
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ value: 'under_attack' }),
      }),
    );
  });
});

describe('listR2Buckets', () => {
  test('maps the nested buckets payload', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          buckets: [
            {
              name: 'assets',
              location: 'WNAM',
              creation_date: '2026-01-01T00:00:00Z',
            },
            { name: 'bare' },
          ],
        },
      }),
    );

    await expect(listR2Buckets('secret', 'acc-1')).resolves.toEqual([
      {
        name: 'assets',
        location: 'WNAM',
        creationDate: '2026-01-01T00:00:00Z',
      },
      { name: 'bare', location: '', creationDate: null },
    ]);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets',
    );
  });
});

describe('createR2Bucket', () => {
  test('sends the name and optional location hint', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { name: 'assets' } }),
    );

    await createR2Bucket('secret', 'acc-1', 'assets', 'wnam');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'assets',
      locationHint: 'wnam',
    });
  });
});

describe('r2 managed domain', () => {
  test('maps the r2.dev public URL flag', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { domain: 'pub-abc.r2.dev', enabled: true },
      }),
    );

    await expect(
      getR2ManagedDomain('secret', 'acc-1', 'assets'),
    ).resolves.toEqual({ domain: 'pub-abc.r2.dev', enabled: true });
  });

  test('puts the enabled flag when updating', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await setR2ManagedDomain('secret', 'acc-1', 'assets', false);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets/assets/domains/managed',
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });
});

describe('listKvNamespaces', () => {
  test('returns id/title pairs', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          { id: 'ns-1', title: 'SESSIONS', supports_url_encoding: true },
        ],
      }),
    );

    await expect(listKvNamespaces('secret', 'acc-1')).resolves.toEqual([
      { id: 'ns-1', title: 'SESSIONS' },
    ]);
  });
});

describe('getKvEntries', () => {
  test('reads values with their metadata in one batch', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          values: {
            'k-1': { value: 'v1', metadata: { tag: 'a' }, expiration: 1893456000 },
            'k-2': { value: 'v2' },
            'k-3': null,
          },
        },
      }),
    );

    const entries = await getKvEntries('secret', 'acc-1', 'ns-1', [
      'k-1',
      'k-2',
      'k-3',
    ]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/bulk/get',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      keys: ['k-1', 'k-2', 'k-3'],
      type: 'text',
      withMetadata: true,
    });
    expect(entries.get('k-1')).toEqual({
      value: 'v1',
      metadata: { tag: 'a' },
      expiration: 1893456000,
    });
    expect(entries.get('k-2')).toEqual({
      value: 'v2',
      metadata: null,
      expiration: null,
    });
    // A key that no longer exists comes back as null rather than being omitted.
    expect(entries.has('k-3')).toBe(false);
  });

  test('splits more than 100 keys across requests', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { values: {} } }),
    );

    const keys = Array.from({ length: 250 }, (_, index) => `k-${index}`);
    await getKvEntries('secret', 'acc-1', 'ns-1', keys);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const sizes = mockFetch.mock.calls.map(
      ([, init]) => (JSON.parse(init.body) as { keys: string[] }).keys.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
  });

  test('makes no request for an empty key list', async () => {
    await expect(
      getKvEntries('secret', 'acc-1', 'ns-1', []),
    ).resolves.toEqual(new Map());
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('putKvValue', () => {
  test('writes through the bulk endpoint, carrying metadata and expiry over', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { successful_key_count: 1 } }),
    );

    await putKvValue('secret', 'acc-1', 'ns-1', {
      key: 'k-1',
      value: 'v1',
      metadata: { tag: 'a' },
      expiration: 4102444800,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/bulk',
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual([
      {
        key: 'k-1',
        value: 'v1',
        metadata: { tag: 'a' },
        expiration: 4102444800,
      },
    ]);
  });

  test('drops an expiry that has already passed, which the API would reject', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { successful_key_count: 1 } }),
    );

    await putKvValue('secret', 'acc-1', 'ns-1', {
      key: 'k-1',
      value: 'v1',
      expiration: 1,
    });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual([
      { key: 'k-1', value: 'v1' },
    ]);
  });

  test('throws when the key comes back as unsuccessful', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { successful_key_count: 0, unsuccessful_keys: ['k-1'] },
      }),
    );

    await expect(
      putKvValue('secret', 'acc-1', 'ns-1', { key: 'k-1', value: 'v1' }),
    ).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

describe('deleteKvKeys', () => {
  test('reports the keys that failed instead of throwing', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { successful_key_count: 1, unsuccessful_keys: ['k-2'] },
      }),
    );

    const outcome = await deleteKvKeys('secret', 'acc-1', 'ns-1', [
      'k-1',
      'k-2',
    ]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/bulk/delete',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(['k-1', 'k-2']);
    expect(outcome).toEqual({ deleted: ['k-1'], failed: ['k-2'] });
  });

  test('treats a null result as a clean delete', async () => {
    // Several Cloudflare delete endpoints answer `result: null` on success;
    // reading through it would report a delete that happened as a failure.
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: null }));

    await expect(
      deleteKvKeys('secret', 'acc-1', 'ns-1', ['k-1']),
    ).resolves.toEqual({ deleted: ['k-1'], failed: [] });
  });
});

describe('listD1Databases', () => {
  test('maps databases with optional size fields', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            uuid: 'db-1',
            name: 'prod-db',
            version: 'production',
            created_at: '2026-02-02T00:00:00Z',
            file_size: 4096,
            num_tables: 12,
          },
          { uuid: 'db-2', name: 'bare-db' },
        ],
      }),
    );

    await expect(listD1Databases('secret', 'acc-1')).resolves.toEqual([
      {
        uuid: 'db-1',
        name: 'prod-db',
        version: 'production',
        createdAt: '2026-02-02T00:00:00Z',
        fileSize: 4096,
        numTables: 12,
      },
      {
        uuid: 'db-2',
        name: 'bare-db',
        version: '',
        createdAt: null,
        fileSize: null,
        numTables: null,
      },
    ]);
  });
});

describe('listWorkerScripts', () => {
  test('maps script ids and timestamps', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'api-gateway',
            created_on: '2026-01-01T00:00:00Z',
            modified_on: '2026-08-01T00:00:00Z',
          },
        ],
      }),
    );

    await expect(listWorkerScripts('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'api-gateway',
        createdOn: '2026-01-01T00:00:00Z',
        modifiedOn: '2026-08-01T00:00:00Z',
      },
    ]);
  });

  test('fetches the remaining pages in parallel after the first', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'worker-a' }],
          result_info: { total_pages: 3 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: 'worker-b' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: 'worker-c' }] }),
      );

    const scripts = await listWorkerScripts('secret', 'acc-1');

    expect(scripts.map((script) => script.id)).toEqual([
      'worker-a',
      'worker-b',
      'worker-c',
    ]);
    expect(mockFetch.mock.calls[0][0]).toContain(
      '/workers/scripts?page=1&per_page=100',
    );
    expect(mockFetch.mock.calls[1][0]).toContain(
      '/workers/scripts?page=2&per_page=100',
    );
    expect(mockFetch.mock.calls[2][0]).toContain(
      '/workers/scripts?page=3&per_page=100',
    );
  });

  test('falls back to legacy pagination when list options are rejected', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [
              {
                code: 7000,
                message:
                  'Invalid list options provided. Review the `page` or `per_page` parameter.',
              },
            ],
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: 'worker-a' }] }),
      );

    await expect(listWorkerScripts('secret', 'acc-1')).resolves.toEqual([
      { id: 'worker-a', createdOn: null, modifiedOn: null },
    ]);
    // The retry drops the per_page option entirely.
    expect(mockFetch.mock.calls[1][0]).toContain('/workers/scripts?page=1');
    expect(mockFetch.mock.calls[1][0]).not.toContain('per_page');

    // The rejection is remembered: refreshes skip the doomed request.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, result: [{ id: 'worker-a' }] }),
    );
    await listWorkerScripts('secret', 'acc-1');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).not.toContain('per_page');
  });

  test('legacy pagination still parallelizes the remaining pages', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 7000, message: 'Invalid list options provided.' }],
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ id: 'worker-a' }],
          result_info: { total_count: 3, per_page: 1 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: 'worker-b' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: 'worker-c' }] }),
      );

    const scripts = await listWorkerScripts('secret', 'acc-1');

    expect(scripts.map((script) => script.id)).toEqual([
      'worker-a',
      'worker-b',
      'worker-c',
    ]);
    expect(mockFetch.mock.calls[2][0]).toContain('/workers/scripts?page=2');
    expect(mockFetch.mock.calls[3][0]).toContain('/workers/scripts?page=3');
    expect(mockFetch.mock.calls[3][0]).not.toContain('per_page');
  });

  test('does not mask unrelated failures behind the fallback', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false }, 500));

    await expect(listWorkerScripts('secret', 'acc-1')).rejects.toMatchObject({
      code: 'api',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('listWorkerVersions', () => {
  test('maps versions from the items wrapper', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          items: [
            {
              id: 'ver-1',
              number: 5,
              metadata: { created_on: '2026-08-11T00:00:00Z' },
              annotations: { 'workers/message': 'deploy' },
            },
          ],
        },
      }),
    );

    await expect(
      listWorkerVersions('secret', 'acc-1', 'api-gateway'),
    ).resolves.toEqual([
      {
        id: 'ver-1',
        number: 5,
        createdOn: '2026-08-11T00:00:00Z',
        message: 'deploy',
      },
    ]);
  });
});

describe('getActiveWorkerVersion', () => {
  test('returns the version taking the largest traffic share', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          deployments: [
            {
              versions: [
                { version_id: 'ver-old', percentage: 10 },
                { version_id: 'ver-new', percentage: 90 },
              ],
            },
          ],
        },
      }),
    );

    await expect(
      getActiveWorkerVersion('secret', 'acc-1', 'api-gateway'),
    ).resolves.toBe('ver-new');
  });
});

describe('rollbackWorkerVersion', () => {
  test('creates a forced deployment pinned at 100%', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: {} }),
    );

    await rollbackWorkerVersion('secret', 'acc-1', 'api-gateway', 'ver-old');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/workers/scripts/api-gateway/deployments?force=true',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      strategy: 'percentage',
      versions: [{ version_id: 'ver-old', percentage: 100 }],
    });
  });
});

describe('worker subdomain config', () => {
  test('maps enabled flags from the subdomain endpoint', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: { enabled: true, previews_enabled: false },
      }),
    );

    await expect(
      getWorkerSubdomainConfig('secret', 'acc-1', 'api-gateway'),
    ).resolves.toEqual({ enabled: true, previewsEnabled: false });
  });

  test('posts snake_case flags when updating', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await setWorkerSubdomainConfig('secret', 'acc-1', 'api-gateway', {
      enabled: true,
      previewsEnabled: false,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/workers/scripts/api-gateway/subdomain',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      enabled: true,
      previews_enabled: false,
    });
  });
});

describe('pages preview deployment setting', () => {
  test('returns null for direct-upload projects without a source', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, result: { name: 'marketing-site' } }),
    );

    await expect(
      getPagesPreviewSetting('secret', 'acc-1', 'marketing-site'),
    ).resolves.toBeNull();
  });

  test('reads the current setting and patches a merged source object', async () => {
    const source = {
      type: 'github',
      config: {
        owner: 'acme',
        repo_name: 'site',
        preview_deployment_setting: 'all',
      },
    };
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: { source } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }));

    await setPagesPreviewSetting('secret', 'acc-1', 'marketing-site', 'none');

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/pages/projects/marketing-site',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      source: {
        type: 'github',
        config: {
          owner: 'acme',
          repo_name: 'site',
          preview_deployment_setting: 'none',
        },
      },
    });
  });
});

describe('pages domains and rollback', () => {
  test('listPagesDomains maps name and status', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [{ id: 'pd-1', name: 'www.acme.com', status: 'active' }],
      }),
    );

    await expect(
      listPagesDomains('secret', 'acc-1', 'marketing-site'),
    ).resolves.toEqual([
      { id: 'pd-1', name: 'www.acme.com', status: 'active' },
    ]);
  });

  test('rollbackPagesDeployment posts to the rollback endpoint', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await rollbackPagesDeployment('secret', 'acc-1', 'marketing-site', 'dep-2');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/pages/projects/marketing-site/deployments/dep-2/rollback',
    );
    expect(init.method).toBe('POST');
  });
});

describe('listPagesProjects', () => {
  test('maps domains, framework and deployment status', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            name: 'marketing-site',
            domains: ['marketing.pages.dev', 'www.acme.com'],
            production_branch: 'main',
            production_script_name: 'pages-worker--123-production',
            build_config: { framework: 'astro' },
            latest_deployment: {
              deployment_trigger: {
                metadata: { branch: 'main', commit_hash: 'abcdef1234567890' },
              },
              latest_stage: { name: 'deploy', status: 'success' },
              created_on: '2026-08-10T00:00:00Z',
            },
          },
          { name: 'undeployed' },
        ],
      }),
    );

    await expect(listPagesProjects('secret', 'acc-1')).resolves.toEqual([
      {
        name: 'marketing-site',
        domain: 'marketing.pages.dev',
        productionBranch: 'main',
        framework: 'astro',
        productionScriptName: 'pages-worker--123-production',
        deployStatus: 'success',
        deployBranch: 'main',
        deployCommit: 'abcdef1',
        deployedAt: '2026-08-10T00:00:00Z',
      },
      {
        name: 'undeployed',
        domain: '',
        productionBranch: '',
        framework: '',
        productionScriptName: null,
        deployStatus: null,
        deployBranch: null,
        deployCommit: null,
        deployedAt: null,
      },
    ]);
  });

  test('follows pagination until every project is fetched', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ name: 'project-a' }],
          result_info: { total_count: 2 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ name: 'project-b' }],
          result_info: { total_count: 2 },
        }),
      );

    const projects = await listPagesProjects('secret', 'acc-1');

    expect(projects.map((project) => project.name)).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(mockFetch.mock.calls[0][0]).toContain(
      '/pages/projects?page=1&per_page=100',
    );
    expect(mockFetch.mock.calls[1][0]).toContain(
      '/pages/projects?page=2&per_page=100',
    );
  });

  test('stops after the first page when result_info reports one page', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [{ name: 'only-project' }],
        result_info: { total_count: 1, total_pages: 1 },
      }),
    );

    const projects = await listPagesProjects('secret', 'acc-1');

    expect(projects).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('falls back to legacy pagination when list options are rejected', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [
              {
                code: 7000,
                message:
                  'Invalid list options provided. Review the `page` or `per_page` parameter.',
              },
            ],
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ name: 'project-a' }],
          result_info: { total_count: 1 },
        }),
      );

    const projects = await listPagesProjects('secret', 'acc-1');

    expect(projects.map((project) => project.name)).toEqual(['project-a']);
    expect(mockFetch.mock.calls[1][0]).toContain('/pages/projects?page=1');
    expect(mockFetch.mock.calls[1][0]).not.toContain('per_page');
  });
});

describe('management APIs', () => {
  test('maps notification history', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'n-1',
            name: 'SSL Notification',
            alert_type: 'universal_ssl_event_type',
            alert_body: 'SSL certificate has expired',
            sent: '2026-08-14T01:00:00Z',
          },
        ],
      }),
    );

    await expect(listAlertHistory('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'n-1',
        title: 'SSL Notification',
        detail: 'SSL certificate has expired',
        type: 'universal_ssl_event_type',
        sent: '2026-08-14T01:00:00Z',
      },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/alerting/v3/history?page=1&per_page=25',
    );
  });

  test('maps load balancers and pools', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'lb-1',
            name: 'api.acme.com',
            enabled: true,
            steering_policy: 'dynamic_latency',
            default_pools: ['pool-1'],
            fallback_pool: 'pool-2',
          },
        ],
      }),
    );
    await expect(listLoadBalancers('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'lb-1',
        name: 'api.acme.com',
        enabled: true,
        steering: 'dynamic_latency',
        poolIds: ['pool-1', 'pool-2'],
      },
    ]);

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'pool-1',
            name: 'us-east',
            enabled: true,
            origins: [{ enabled: true }, { enabled: false }],
          },
        ],
      }),
    );
    await expect(listLoadBalancerPools('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'pool-1',
        name: 'us-east',
        enabled: true,
        originCount: 2,
        originEnabled: 1,
      },
    ]);

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'lb-2',
            name: 'www.acme.com',
            enabled: true,
            steering_policy: 'geo',
            default_pools: ['pool-1'],
          },
        ],
      }),
    );
    await expect(listZoneLoadBalancers('secret', 'zone-1')).resolves.toEqual([
      {
        id: 'lb-2',
        name: 'www.acme.com',
        enabled: true,
        steering: 'geo',
        poolIds: ['pool-1'],
      },
    ]);
    expect(mockFetch.mock.calls.at(-1)?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/zones/zone-1/load_balancers',
    );
  });

  test('maps audit logs and subscriptions', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'a-1',
            action: { type: 'dns_record.create' },
            actor: {
              email: 'sarah@acme.com',
              ip: '203.0.113.9',
              type: 'user',
            },
            resource: { type: 'dns_record' },
            when: '2026-08-14T16:38:00Z',
          },
        ],
      }),
    );
    await expect(listAuditLogs('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'a-1',
        action: 'dns_record.create',
        actionKind: 'create',
        result: '',
        resource: 'dns_record',
        resourceId: '',
        zone: '',
        actor: 'sarah@acme.com',
        actorKind: 'user',
        ip: '203.0.113.9',
        when: '2026-08-14T16:38:00Z',
      },
    ]);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/accounts/acc-1/logs/audit?',
    );
    expect(String(mockFetch.mock.calls[0][0])).not.toMatch(/\.\d{3}Z/);
  });

  test('maps v2 audit fields including result and zone', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'a-v2',
            action: {
              type: 'create',
              description: 'Add Member',
              result: 'success',
              time: '2026-08-14T17:31:07Z',
            },
            actor: {
              email: 'alice@example.com',
              ip_address: '198.41.129.166',
              type: 'user',
            },
            resource: { type: 'member', id: 'mem-1', product: 'members' },
            zone: { name: 'acme.com' },
          },
        ],
      }),
    );
    await expect(listAuditLogs('secret', 'acc-1')).resolves.toMatchObject([
      {
        id: 'a-v2',
        action: 'Add Member',
        actionKind: 'create',
        result: 'success',
        resource: 'member',
        resourceId: 'mem-1',
        zone: 'acme.com',
        actor: 'alice@example.com',
      },
    ]);
  });

  test('falls back to classic audit_logs when v2 is forbidden', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [] }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [] }, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [
            {
              id: 'a-2',
              action: { type: 'update' },
              actor: { email: 'ops@acme.com', ip: '1.1.1.1' },
              resource: { type: 'zone' },
              when: '2026-08-14T12:00:00Z',
            },
          ],
        }),
      );

    await expect(listAuditLogs('secret', 'acc-1')).resolves.toMatchObject([
      { id: 'a-2', actor: 'ops@acme.com', action: 'update' },
    ]);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/logs/audit?');
    expect(String(mockFetch.mock.calls[2][0])).toContain(
      '/accounts/acc-1/audit_logs?',
    );
  });

  test('falls back to user audit logs when account endpoints are forbidden', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [] }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [] }, 403))
      .mockResolvedValueOnce(jsonResponse({ success: false, errors: [] }, 403))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [
            {
              id: 'a-3',
              action: { type: 'login' },
              actor: { email: 'you@example.com' },
              when: '2026-08-14T10:00:00Z',
            },
          ],
        }),
      );

    await expect(listAuditLogs('secret', 'acc-1')).resolves.toMatchObject([
      { id: 'a-3', actor: 'you@example.com', action: 'login' },
    ]);
    expect(String(mockFetch.mock.calls[3][0])).toContain('/user/audit_logs?');
  });

  test('maps subscriptions', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          {
            id: 'sub-1',
            price: 5,
            currency: 'USD',
            frequency: 'monthly',
            state: 'Paid',
            current_period_start: '2026-08-01T00:00:00Z',
            current_period_end: '2026-08-31T00:00:00Z',
            product: { name: 'prod_workers', key: 'workers' },
            rate_plan: {
              id: 'workers_paid',
              public_name: 'Workers Paid',
              scope: 'user',
            },
            component_values: [
              { name: 'requests', value: 10000000 },
              { name: 'r2_ia_enabled', value: 1 },
            ],
          },
        ],
      }),
    );
    await expect(listSubscriptions('secret', 'acc-1')).resolves.toEqual([
      {
        id: 'sub-1',
        name: 'Workers Paid',
        planId: 'workers_paid',
        scope: 'user',
        frequency: 'monthly',
        state: 'Paid',
        price: 5,
        currency: 'USD',
        extras: '',
        started: '2026-08-01T00:00:00Z',
        ended: '2026-08-31T00:00:00Z',
      },
    ]);
  });
});

describe('deleteR2Object', () => {
  const base = 'https://api.cloudflare.com/client/v4';

  test('sends path separators literally but encodes the rest', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await deleteR2Object('secret', 'acc-1', 'assets', 'img/a b&c?.png');

    const [url, init] = mockFetch.mock.calls[0];
    // Cloudflare addresses a different object if the slash is percent-encoded,
    // while an unencoded `?` would be read as the start of a query string.
    expect(url).toBe(
      `${base}/accounts/acc-1/r2/buckets/assets/objects/img/a%20b%26c%3F.png`,
    );
    expect(init.method).toBe('DELETE');
  });

  test('keeps nested prefixes addressable', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await deleteR2Object('secret', 'acc-1', 'assets', 'a/b/c/deep.txt');

    expect(mockFetch.mock.calls[0][0]).toBe(
      `${base}/accounts/acc-1/r2/buckets/assets/objects/a/b/c/deep.txt`,
    );
  });
});

describe('deleteR2Objects', () => {
  test('deletes every key and reports them', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await expect(
      deleteR2Objects('secret', 'acc-1', 'assets', ['a.txt', 'b.txt']),
    ).resolves.toEqual({ deleted: ['a.txt', 'b.txt'], failed: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('reports a partial delete instead of throwing', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }))
      .mockResolvedValueOnce(
        jsonResponse({ success: false, errors: [{ message: 'nope' }] }, 403),
      )
      .mockResolvedValue(jsonResponse({ success: true, result: {} }));

    const outcome = await deleteR2Objects('secret', 'acc-1', 'assets', [
      'a.txt',
      'b.txt',
      'c.txt',
    ]);

    // The successful deletions already happened, so they must be reported
    // rather than lost behind a thrown error.
    expect(outcome.deleted).toEqual(['a.txt', 'c.txt']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].key).toBe('b.txt');
    expect(outcome.failed[0].cause).toBeInstanceOf(CloudflareApiError);
  });

  test('does nothing when nothing is selected', async () => {
    await expect(
      deleteR2Objects('secret', 'acc-1', 'assets', []),
    ).resolves.toEqual({ deleted: [], failed: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
