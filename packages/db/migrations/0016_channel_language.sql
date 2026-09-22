-- A public form speaks the language of the site it is embedded in.
--
-- The channel's `purpose_text` is already whatever an owner wrote, so it was never the problem.
-- The form's own labels were English regardless, which on a German venture site produced a
-- disclosure in German surrounded by controls in English — a worse impression than either
-- language alone, and a worse one to submit an address into.
--
-- Defaults to `en`, so an existing channel keeps behaving exactly as it did.
ALTER TABLE oe.intake_channels
  ADD COLUMN language char(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'de'));
