import axios from 'axios';
import FormData from 'form-data';
import config from '../config';

const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const PINATA_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_TEST_URL = 'https://api.pinata.cloud/data/testAuthentication';

function headers() {
  return {
    pinata_api_key: config.pinata.apiKey,
    pinata_secret_api_key: config.pinata.secret,
  };
}

/** Pin a JSON object to IPFS via Pinata. Returns the CID. */
export async function pinJson(body: object): Promise<string> {
  const res = await axios.post(PINATA_PIN_URL, body, { headers: headers() });
  return res.data.IpfsHash as string;
}

/** Pin a file buffer to IPFS via Pinata. Returns the CID. */
export async function pinFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType });
  const res = await axios.post(PINATA_FILE_URL, form, {
    headers: { ...headers(), ...form.getHeaders() },
    maxBodyLength: Infinity,
  });
  return res.data.IpfsHash as string;
}

/** Build a public gateway URL for a CID. */
export function gatewayUrl(cid: string): string {
  return `${config.pinata.gateway}/ipfs/${cid}`;
}

/**
 * Health check for the IPFS/Pinata service dependency.
 * Calls the Pinata authentication test endpoint to confirm connectivity.
 * Resolves on success; rejects with an error if the service is unreachable
 * or returns a non-2xx status.
 *
 * Stub this function in tests to avoid real network calls.
 */
export async function checkHealth(): Promise<void> {
  await axios.get(PINATA_TEST_URL, { headers: headers() });
}
