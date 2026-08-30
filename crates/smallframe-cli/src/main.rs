#![forbid(unsafe_code)]

mod app;
mod identity;

use app::{new_app, pack, validate_path};
use clap::{Parser, Subcommand};
use identity::{IdentityContext, read_passphrase};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "smallframe",
    version,
    about = "Build and verify Smallframe packages"
)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true, value_name = "DIRECTORY", hide = true)]
    test_store: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Identity {
        #[command(subcommand)]
        command: IdentityCommand,
    },
    New {
        name: String,
        #[arg(long, default_value = ".")]
        directory: PathBuf,
    },
    Validate {
        path: PathBuf,
    },
    Pack {
        path: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum IdentityCommand {
    Init,
    Export {
        #[arg(long)]
        output: PathBuf,
        #[arg(long, value_name = "OWNER_ONLY_FILE")]
        passphrase_file: Option<PathBuf>,
    },
    Import {
        path: PathBuf,
        #[arg(long, value_name = "OWNER_ONLY_FILE")]
        passphrase_file: Option<PathBuf>,
    },
}

#[derive(Debug)]
struct CliError {
    code: String,
    detail: String,
    exit: u8,
}

impl CliError {
    fn from_message(message: String) -> Self {
        let code = message
            .split([':', ' '])
            .next()
            .unwrap_or("INTERNAL")
            .to_owned();
        let exit = if code.contains("KEY_STORE")
            || code.contains("VAULT")
            || code.contains("IDENTITY_NOT")
        {
            6
        } else if code == "INTERNAL" {
            10
        } else {
            2
        };
        Self {
            code,
            detail: message,
            exit,
        }
    }
}

fn emit<T: Serialize>(value: &T, json_mode: bool) -> Result<(), CliError> {
    let encoded = if json_mode {
        serde_json::to_string(value)
    } else {
        serde_json::to_string_pretty(value)
    }
    .map_err(|_| CliError::from_message("INTERNAL JSON_OUTPUT_FAILED".to_owned()))?;
    println!("{encoded}");
    Ok(())
}

fn run(cli: &Cli) -> Result<(), CliError> {
    match &cli.command {
        Command::Identity { command } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            match command {
                IdentityCommand::Init => {
                    emit(&context.init().map_err(CliError::from_message)?, cli.json)
                }
                IdentityCommand::Export {
                    output,
                    passphrase_file,
                } => {
                    if !cli.json {
                        eprintln!(
                            "Warning: this recovery file can restore your publisher identity."
                        );
                        eprintln!(
                            "Warning: keep it offline; Smallframe cannot recover a lost key."
                        );
                    }
                    let passphrase = read_passphrase(passphrase_file.as_deref(), true)
                        .map_err(CliError::from_message)?;
                    emit(
                        &context
                            .export(output, &passphrase)
                            .map_err(CliError::from_message)?,
                        cli.json,
                    )
                }
                IdentityCommand::Import {
                    path,
                    passphrase_file,
                } => {
                    let passphrase = read_passphrase(passphrase_file.as_deref(), false)
                        .map_err(CliError::from_message)?;
                    emit(
                        &context
                            .import(path, &passphrase)
                            .map_err(CliError::from_message)?,
                        cli.json,
                    )
                }
            }
        }
        Command::New { name, directory } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            let signing_key = context.signing_key().map_err(CliError::from_message)?;
            let path = new_app(name, directory, &signing_key).map_err(CliError::from_message)?;
            emit(&json!({"path": path}), cli.json)
        }
        Command::Validate { path } => emit(
            &validate_path(path).map_err(CliError::from_message)?,
            cli.json,
        ),
        Command::Pack { path, output } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            let signing_key = context.signing_key().map_err(CliError::from_message)?;
            emit(
                &pack(path, output, &signing_key).map_err(CliError::from_message)?,
                cli.json,
            )
        }
    }
}

fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(&cli) {
        if cli.json {
            eprintln!("{}", json!({"ok":false,"error":{"code":error.code}}));
        } else {
            eprintln!("{}", error.detail);
        }
        std::process::exit(i32::from(error.exit));
    }
}
