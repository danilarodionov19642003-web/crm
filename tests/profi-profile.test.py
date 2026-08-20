import unittest

from app.profi_profile import extract_avatar_url, normalize_profile_url


class ProfiProfileTest(unittest.TestCase):
    def test_normalizes_public_profile_url(self):
        self.assertEqual(
            normalize_profile_url("profi.ru/profile/YevdakimovAS2?from=test"),
            "https://profi.ru/profile/YevdakimovAS2/",
        )

    def test_rejects_other_hosts_and_paths(self):
        for value in (
            "https://example.com/profile/YevdakimovAS2",
            "https://profi.ru/order/123",
            "https://profi.ru:8080/profile/YevdakimovAS2",
            "https://sub.profi.ru/profile/YevdakimovAS2",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_profile_url(value)

    def test_extracts_avatar_from_public_json_ld(self):
        html = """
        <script type="application/ld+json">
          {"@type":"LocalBusiness","logo":"https://cdn.profi.ru/xfiles/pfiles/avatar.jpg-profi_a34-240.jpg"}
        </script>
        """
        self.assertEqual(
            extract_avatar_url(html),
            "https://cdn.profi.ru/xfiles/pfiles/avatar.jpg-profi_a34-240.jpg",
        )

    def test_does_not_return_untrusted_images(self):
        html = '<script type="application/ld+json">{"logo":"https://internal.example/avatar.jpg"}</script>'
        self.assertEqual(extract_avatar_url(html), "")


if __name__ == "__main__":
    unittest.main()
