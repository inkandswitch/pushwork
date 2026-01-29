{
  description = "Pushwork: Bidirectional directory synchronization using Automerge CRDTs";

  inputs = {
    command-utils.url = "git+https://codeberg.org/expede/nix-command-utils";
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
  };

  outputs = {
    self,
    command-utils,
    flake-utils,
    nixpkgs,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs { inherit system; };

      nodejs = pkgs.nodejs_24;
      pnpm-pkg = pkgs.pnpm;
      pnpm' = "${pnpm-pkg}/bin/pnpm";

      asModule = command-utils.asModule.${system};
      cmd = command-utils.cmd.${system};
      pnpm = command-utils.pnpm.${system};

      pnpm-cfg = { pnpm = pnpm'; };

      menu = command-utils.commands.${system} [
        (pnpm.build pnpm-cfg)
        (pnpm.dev pnpm-cfg)
        (pnpm.install pnpm-cfg)
        (pnpm.test pnpm-cfg)
        (asModule {
          "clean" = cmd "Remove dist directory" "${pnpm'} clean";
          "lint" = cmd "Run ESLint" "${pnpm'} lint";
          "lint:fix" = cmd "Run ESLint with auto-fix" "${pnpm'} lint:fix";
          "start" = cmd "Run the CLI" "${pnpm'} start";
          "test:bail" = cmd "Run tests, stop on first failure" "${pnpm'} test:bail";
          "test:coverage" = cmd "Run tests with coverage" "${pnpm'} test:coverage";
          "test:watch" = cmd "Run tests in watch mode" "${pnpm'} test:watch";
          "typecheck" = cmd "Run TypeScript type checking" "${pnpm'} typecheck";
        })
      ];

    in {
      devShells.default = pkgs.mkShell {
        name = "Pushwork Dev Shell";

        nativeBuildInputs = [
          nodejs
          pkgs.eslint
          pkgs.nodePackages.vscode-langservers-extracted
          pkgs.prettierd
          pkgs.typescript
          pkgs.typescript-language-server
          pnpm-pkg
        ] ++ menu;

        shellHook = ''
          menu
        '';
      };

      formatter = pkgs.alejandra;
    });
}
