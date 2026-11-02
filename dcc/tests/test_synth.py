import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "audio"))
import synth  # noqa: E402


class RadioStaticTest(unittest.TestCase):
    def test_meets_the_default_audio_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "SFX_RadioStatic.wav")
            synth.write_wav16(path, synth.radio_static(2.0, 48000, loop=True), 48000)
            facts = synth.measure(path)
        self.assertEqual(facts["sampleRate"], 48000)
        self.assertAlmostEqual(facts["seconds"], 2.0, places=3)
        self.assertLessEqual(facts["peakDb"], -1.0)
        self.assertTrue(-30 <= facts["rmsDb"] <= -12, facts["rmsDb"])
        self.assertLess(facts["loopSeam"], 0.05)

    def test_is_reproducible(self):
        self.assertEqual(synth.radio_static(0.1, 8000, seed=7), synth.radio_static(0.1, 8000, seed=7))
        self.assertNotEqual(synth.radio_static(0.1, 8000, seed=7), synth.radio_static(0.1, 8000, seed=8))


if __name__ == "__main__":
    unittest.main()
