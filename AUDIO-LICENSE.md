# Audio assets

The pronunciation clips in `public/audio/*.mp3` were generated with **Amazon Polly**
(Standard engine, voices *Joanna* and *Joey*) from the vocabulary text in this repository, which is
the author's own content.

## Redistribution basis

Under the [AWS Service Terms](https://aws.amazon.com/service-terms/), the AI Services section lists
Amazon Polly as an AI Service and states that output generated using AI Services is "Your Content"
(§50.1–50.2). On that basis the generated speech is the author's content and is redistributed here
as part of this MIT-licensed project. *(Terms summarized/paraphrased for brevity; the linked Service
Terms are authoritative — review the current version before relying on this.)*

- No third-party fonts or other third-party media are bundled in this repository.
- The MIT `LICENSE` covers the source code. These generated MP3s are included under the same
  repository for convenience, per the basis above.

## Regenerating the audio yourself

You do not need the committed MP3s — you can regenerate them from text with an AWS account:

```sh
EXPECTED_ACCOUNT=<your-aws-account-id> python3 scripts/generate_audio.py            # dry run (no cost)
EXPECTED_ACCOUNT=<your-aws-account-id> python3 scripts/generate_audio.py --confirm  # synthesize (<= $1 cap)
```

`EXPECTED_ACCOUNT` is required and the script fails closed if it is unset. The run is a dry run
unless `--confirm` is passed, and it refuses to proceed if the estimated Polly charge exceeds the
built-in $1 cap. Voices and voice balance are validated before any billable call.
