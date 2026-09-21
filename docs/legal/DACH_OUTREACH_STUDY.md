# DACH outreach · what the law actually permits

**Research summary, 21 September 2026. Not legal advice.**

I am not a lawyer and this is not a legal opinion. It is a reading of the current statutory
text, retrieved from the official source on the date above, plus the consequences that follow
for this product. A German `Fachanwalt für gewerblichen Rechtsschutz` must sign it off before
any outreach happens. Where I am uncertain I say so rather than smoothing it over.

Primary source: **§ 7 UWG — Unzumutbare Belästigungen**,
<https://www.gesetze-im-internet.de/uwg_2004/__7.html>, text as retrieved 21 September 2026.

---

## 1. The finding that decides the product direction

**§ 7 (2) Nr. 2 UWG** treats it as _always_ an unreasonable nuisance to advertise

> "unter Verwendung einer automatischen Anrufmaschine, eines Faxgerätes oder **elektronischer
> Post, ohne dass eine vorherige ausdrückliche Einwilligung des Adressaten vorliegt**"

— using an automatic calling machine, a fax machine or **electronic mail, without the
addressee's prior express consent**.

Read the sentence for what it does **not** say. It does not say "consumer". It does not carve
out business recipients. §7(2) Nr. 1, immediately above it, _does_ distinguish consumers from
other market participants for telephone advertising — so the absence of that distinction in
Nr. 2 is deliberate drafting, not an oversight.

**Consequence: cold commercial email to German businesses requires prior express opt-in.**
Being B2B does not help. Finding the address published on a company's own website does not
help. An inferred "legitimate interest" under GDPR does not help, because UWG §7 is a separate
channel rule that sits on top of data-protection law.

## 2. What that means for "make it like Explee"

Explee's homepage sells an "AutoGTM … 24/7 AI-agent that finds clients while you sleep",
measured in "hot leads" and "cost per lead" — automated outbound prospecting and sending.

Against §7(2) Nr. 2, **that model cannot be operated lawfully from Germany against German
recipients** in its automated-cold-email form. It is not a matter of volume, tone or
personalisation. The trigger is sending advertising by electronic mail without prior express
consent, and an AI writing the mail changes nothing about the trigger.

This is also, independently, what the build kit already concluded. BUILD_SPEC.md §2:

> **Do not copy:** dependence on automated cold outreach, opaque usage growth or a feature
> race over database size.

and §19 lists "autonomous cold-email engine, mailbox warming, huge contact warehouse" under
**explicitly excluded**. So the kit's design and the statute point the same way. I did not know
that when I started reading the statute; they agree.

**This is your call, not mine.** It is your business and you can direct me to build whatever
you want. But you asked me to study the question, and the honest answer is that the specific
mechanism Explee sells is the one mechanism German law closes off. What I would not do is
build it quietly and let you discover this from a `Abmahnung`.

## 3. The channels that are open

| Channel                                                                             | Status under §7                                                                                            | What it needs                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Inbound requested check** — a visitor submits their own URL and asks for a report | Clean. They initiated it.                                                                                  | Deliver only what was requested. A requested report is not consent to market to them afterwards.             |
| **Existing customer, similar service**                                              | Permitted under **§7(3)**, but only if _all four_ conditions hold                                          | See below                                                                                                    |
| **Telephone to a business**                                                         | §7(2) Nr. 1: needs at least _presumed_ consent (`mutmaßliche Einwilligung`)                                | A lower bar than email, but still a bar, and courts read it narrowly. Needs counsel input on what qualifies. |
| **Telephone to a consumer**                                                         | Prior express consent                                                                                      | Effectively closed for prospecting                                                                           |
| **Partner introduction**                                                            | Outside §7 if the partner introduces you and the recipient responds                                        | Document who introduced whom                                                                                 |
| **Content, events, search, paid ads**                                               | Not covered by §7 at all                                                                                   | Ordinary marketing spend                                                                                     |
| **Postal mail**                                                                     | Not covered by §7(2); GDPR still applies                                                                   | Separate analysis; often viable                                                                              |
| **Contact forms, LinkedIn DMs, WhatsApp**                                           | **Do not assume these are safe.** They are widely treated as electronic messages for advertising purposes. | Counsel review before any use                                                                                |

### The §7(3) existing-customer exception, in full

All four conditions must be met at once:

1. the trader obtained the address **in connection with the sale** of a good or service to that
   customer;
2. the address is used for direct marketing of the trader's **own similar** goods or services;
3. the customer **has not objected**; and
4. the customer is told **clearly, both when the address is collected and on every single use**,
   that they may object at any time at no cost beyond basic transmission charges.

Each is a trap. "In connection with a sale" is not "they filled in a form". "Own similar" is
read narrowly — a link repair customer is not automatically a candidate for a photography
package. And condition 4 means the notice has to be in _every_ message, not just the first.

## 4. The layer underneath: GDPR

§7 UWG governs the _channel_. The GDPR separately governs _processing the personal data_ —
lawful basis, transparency, retention, and the absolute right to object to direct marketing
(Art. 21(2), which admits no balancing test). Satisfying one does not satisfy the other.

Practical consequences that reach into the code:

- A business contact's name and work address are still personal data.
- A legitimate-interest assessment for _research_ does not authorise _sending_.
- You need a record of source, purpose, notice status, objections and suppression scope —
  which is why the data model has `authorizations` and `audit_events` with purpose and expiry,
  and why `suppression` is listed in the kit's entity table.

## 5. Austria and Switzerland

**Do not treat the German answer as a DACH answer.** Austria regulates electronic mail
advertising under its telecommunications act and Switzerland under its own UWG with different
mechanics. I have not researched either to the standard of §7 above, and I am not going to
summarise them from memory. Each needs its own review before a single message crosses a border.

The kit says the same thing, and it is right: "Austria and Switzerland require separate review;
do not label the German rule as a complete DACH compliance solution."

## 6. What I recommend

1. **Keep the engine's no-send boundary exactly as it is.** There is no outbound adapter in the
   codebase, and `AUTOMATIC_OUTREACH_ENABLED=true` is refused at startup. That is now a legal
   control, not just a design preference.
2. **Build acquisition around the requested check.** A visitor submits their own URL, gets a
   real reviewed report, and is offered a scoped fix. That is M3, it is lawful, and it is a
   better fit for an evidence-first product than cold mail ever was: the proof is the pitch.
3. **Take the §7(3) exception to counsel before using it**, with the exact wording you intend
   for the notice and a written definition of "similar services" for your catalogue.
4. **Record permission per channel, per country, per purpose** — not one global "may contact"
   flag. The data model already supports this; nothing currently writes it.
5. **Get counsel sign-off on the report delivery flow specifically**, since it sits closest to
   the line: a requested report is fine, a requested report followed by unrequested follow-ups
   is not.

## 7. What is still open and needs a lawyer, not me

- Whether your intended phone approach clears `mutmaßliche Einwilligung` for a business.
- The exact §7(3) notice wording, and where "similar" stops for your catalogue.
- Whether contact forms and LinkedIn messages count as `elektronische Post` for your use.
- Austria and Switzerland in full.
- Controller/processor structure between BrandWave, MarktFix and any client data.
- Whether an inbound-request form needs a double opt-in for the delivery address.

---

**Bottom line.** The product you have is on the right side of this. The product Explee sells is
not one you can legally copy for the German market. The fix is not a compliance bolt-on — it is
that the acquisition motion becomes "they ask us", and the evidence engine is what makes that
motion work.
