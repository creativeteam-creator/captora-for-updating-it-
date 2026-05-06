-- Captora: set large media buckets to a 2 GB per-object limit.
--
-- Run this in Supabase SQL Editor for existing projects if uploads fail with:
--   "The object exceeded the maximum allowed size"

update storage.buckets
set file_size_limit = 2147483648 -- 2 GB
where id in ('captora-source', 'captora-renders');

