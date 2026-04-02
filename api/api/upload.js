import Arweave from 'arweave';

const arweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export default async function handler(req, res) {
  // CORSプリフライト
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data, contentType } = req.body;

    if (!data || !contentType) {
      return res.status(400).json({ error: 'Missing data or contentType' });
    }

    const buffer = Buffer.from(data, 'base64');

    // サイズ制限: 2MB
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 2MB)' });
    }

    const key = JSON.parse(process.env.AR_WALLET_KEY);

    const transaction = await arweave.createTransaction({ data: buffer }, key);
    transaction.addTag('Content-Type', contentType);

    await arweave.transactions.sign(transaction, key);
    const response = await arweave.transactions.post(transaction);

    if (response.status === 200 || response.status === 202) {
      const url = `https://arweave.net/${transaction.id}`;
      return res.status(200).json({ url, id: transaction.id });
    } else {
      return res.status(500).json({ error: 'Upload failed', status: response.status });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
