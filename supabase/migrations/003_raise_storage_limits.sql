-- Raise per-object file size limits for Captora's storage buckets.
--
-- The default Supabase bucket cap (50 MB) was rejecting large source
-- uploads with "The object exceeded the maximum allowed size" — long
-- recordings, 4K reels, and anything past a couple of minutes of
-- footage trips it instantly.
--
-- 2 GB supports long phone recordings / high-res clips while still keeping
-- accidental huge uploads bounded.
--
-- Run once in Supabase Dashboard → SQL Editor.

update storage.buckets
set file_size_limit = 2147483648  -- 2 GB
where id in ('captora-source', 'captora-renders');

-- Thumbnails are tiny JPEGs — keep them tight to catch accidental
-- non-thumbnail uploads to this bucket.
update storage.buckets
set file_size_limit = 524288  -- 512 KB
where id = 'captora-thumbnails';

-- Custom user fonts are typically <1 MB each; cap at 5 MB to leave
-- headroom for variable / unicode-heavy faces without inviting abuse.
update storage.buckets
set file_size_limit = 5242880  -- 5 MB
where id = 'captora-fonts';
