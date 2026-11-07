export async function figmaGet(path, query, { token = process.env.FIGMA_ACCESS_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('Set FIGMA_ACCESS_TOKEN with file_content:read scope to use REST tools.');
  const url = new URL(`https://api.figma.com/v1/${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  } catch { throw new Error('Figma API request failed or timed out. Check your network connection.'); }
  if (!response.ok) {
    const messages = { 401: 'Token is invalid or expired.', 403: 'Check token scopes and file access.', 404: 'File or node not found.' };
    const wait = response.headers.get('retry-after');
    throw new Error(`Figma API ${response.status}: ${response.status === 429 ? `Rate limited. Retry after ${wait || 'the indicated wait'} seconds.` : messages[response.status] || 'Request failed.'}`);
  }
  return response.json();
}
