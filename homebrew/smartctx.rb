class Smartctx < Formula
  desc "Smart context manager for AI coding assistants — saves millions of tokens"
  homepage "https://github.com/Abdullahbutt-143/smartctx"
  url "https://registry.npmjs.org/smartctx/-/smartctx-0.2.0.tgz"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "smartctx", shell_output("#{bin}/smartctx --version")
  end
end
