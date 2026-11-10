import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requirePhoneVerified } from '../middleware/auth';
import { badRequest } from '../lib/errors';
import { uploadToBunny } from '../lib/bunny';

const r = Router();
r.use(authenticate, requirePhoneVerified);

const PUBLIC_FOLDERS = ['avatars', 'properties', 'maintenance', 'jobs', 'portfolio', 'chat'] as const;
const PRIVATE_FOLDERS = ['artisan-docs'] as const;
const ALLOWED = /^(image\/(jpeg|png|webp|heic)|video\/(mp4|quicktime)|application\/pdf)$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10 } });

/**
 * POST /uploads?folder=properties   (multipart, field "files", up to 10)
 * Public folders return CDN urls. `artisan-docs` goes to the private zone and returns only a storage path.
 */
r.post('/', upload.array('files', 10), async (req, res) => {
  const { folder } = z.object({ folder: z.enum([...PUBLIC_FOLDERS, ...PRIVATE_FOLDERS]) }).parse(req.query);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const isPrivate = (PRIVATE_FOLDERS as readonly string[]).includes(folder);
  for (const f of files) if (!ALLOWED.test(f.mimetype)) throw badRequest(`Unsupported file type: ${f.mimetype}`, 'BAD_FILE_TYPE');
  if (!isPrivate && files.some((f) => f.mimetype === 'application/pdf') && folder !== 'chat') throw badRequest('PDFs are not allowed here');

  const out = await Promise.all(files.map(async (f) => {
    const { url, path } = await uploadToBunny(f.buffer, `${folder}/${req.user.id}`, f.originalname, isPrivate);
    return { url, path, name: f.originalname, size: f.size, type: f.mimetype.startsWith('video') ? 'video' : f.mimetype === 'application/pdf' ? 'document' : 'image' };
  }));
  res.status(201).json({ files: out });
});

export default r;
