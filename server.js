import express from 'express';
import { runMonitor } from './monitor.js';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('sagawa-monitor is running. Use POST /run');
});

app.post('/run', async (req, res) => {
  try {
    const result = await runMonitor();
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`sagawa-monitor listening on ${port}`);
});
