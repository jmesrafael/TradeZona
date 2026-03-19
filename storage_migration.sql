-- storage_migration.sql
-- ============================================================
--  TradeZona — Storage Migration
--  Run this in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Add storage_path column to trade_images
--    (keeps data column for backwards compat with existing base64 rows)
ALTER TABLE public.trade_images
  ADD COLUMN IF NOT EXISTS storage_path text;

-- 2. Create the storage bucket (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'trade-images',
  'trade-images',
  false,            -- private bucket — only via signed URLs
  5242880,          -- 5 MB per file max
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/heic']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3. Storage RLS policies — users can only touch their own files
--    Path structure: {user_id}/{trade_id}/{filename}

-- Allow authenticated users to upload files under their own user_id folder
CREATE POLICY "Users can upload their own trade images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'trade-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to read their own files
CREATE POLICY "Users can read their own trade images"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'trade-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to delete their own files
CREATE POLICY "Users can delete their own trade images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'trade-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4. Index for faster image lookups by trade
CREATE INDEX IF NOT EXISTS idx_trade_images_storage_path
  ON public.trade_images(storage_path)
  WHERE storage_path IS NOT NULL;

-- 5. (Optional) Update existing base64 rows to mark them clearly
--    They'll keep working — the app falls back to data column automatically
COMMENT ON COLUMN public.trade_images.storage_path IS
  'Supabase Storage path for the image file. Null for legacy base64 rows.';
COMMENT ON COLUMN public.trade_images.data IS
  'Legacy base64 image data. Null for new Storage-backed rows.';
