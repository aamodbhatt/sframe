#![forbid(unsafe_code)]

mod app;
mod identity;
mod publish;
mod snapshot;
mod upload;

use app::{new_app, pack, validate_path};
use clap::{Parser, Subcommand};
use identity::{IdentityContext, read_passphrase};
use publish::{
    enroll_publisher, enrollment_operation_status, publish_package, resume_enrollment_operation,
    resume_room_operation, room_operation_status, room_request_repair, room_revoke,
    room_rotate_links, room_status,
};
use serde::Serialize;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::Command as ProcessCommand,
    time::{SystemTime, UNIX_EPOCH},
};

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
    Enroll {
        #[arg(long)]
        invite_file: Option<PathBuf>,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
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
    Publish {
        path: PathBuf,
        #[arg(long)]
        initial_state: Option<PathBuf>,
        #[arg(long)]
        expires_in: Option<u64>,
        #[arg(long)]
        show_secrets: bool,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
        #[arg(long, default_value = "http://app.localhost:4173")]
        controller_url: String,
    },
    Room {
        #[command(subcommand)]
        command: RoomCommand,
    },
    Operations {
        #[command(subcommand)]
        command: OperationsCommand,
    },
    Export {
        #[command(subcommand)]
        command: ExportCommand,
    },
    Dev {
        path: Option<PathBuf>,
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

#[derive(Debug, Subcommand)]
enum RoomCommand {
    Status {
        #[arg(allow_hyphen_values = true)]
        room_ref: String,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
    },
    RotateLinks {
        #[arg(allow_hyphen_values = true)]
        room_ref: String,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
    },
    Revoke {
        #[arg(allow_hyphen_values = true)]
        room_ref: String,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
    },
    RequestRepair {
        #[arg(allow_hyphen_values = true)]
        room_ref: String,
        #[arg(long)]
        expected_etag: Option<String>,
        #[arg(long, default_value = "http://api.localhost:8787")]
        api_url: String,
    },
}

#[derive(Debug, Subcommand)]
enum OperationsCommand {
    Status {
        #[arg(allow_hyphen_values = true)]
        operation_ref: String,
    },
    Resume {
        #[arg(allow_hyphen_values = true)]
        operation_ref: String,
        #[arg(long)]
        show_secrets: bool,
    },
    Abandon {
        #[arg(allow_hyphen_values = true)]
        operation_ref: String,
    },
}

#[derive(Debug, Subcommand)]
enum ExportCommand {
    Package {
        #[arg(allow_hyphen_values = true)]
        package_or_room_ref: String,
        #[arg(long)]
        output: PathBuf,
    },
}

#[cfg(test)]
mod argument_tests {
    use super::Cli;
    use clap::Parser;

    #[test]
    fn base64url_references_can_start_with_a_hyphen() {
        let reference = "-AAAAAAAAAAAAAAAAAAAAA";
        for action in ["status", "rotate-links", "revoke", "request-repair"] {
            assert!(Cli::try_parse_from(["smallframe", "room", action, reference]).is_ok());
        }
        for action in ["status", "resume", "abandon"] {
            assert!(Cli::try_parse_from(["smallframe", "operations", action, reference]).is_ok());
        }
        assert!(
            Cli::try_parse_from([
                "smallframe",
                "export",
                "package",
                reference,
                "--output",
                "unused-package",
            ])
            .is_ok()
        );
    }
}

#[derive(Debug)]
struct CliError {
    code: String,
    detail: String,
    exit: u8,
    operation_ref: Option<String>,
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
            operation_ref: message
                .strip_prefix("ROOM_CREATION_PENDING:")
                .filter(|value| {
                    value.len() == 22
                        && value.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
                        })
                })
                .map(str::to_owned)
                .or_else(|| {
                    message
                        .strip_prefix("PACKAGE_UPLOAD_PENDING:")
                        .filter(|value| {
                            value.len() == 43
                                && value
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                        })
                        .map(|digest| format!("upload:{digest}"))
                }),
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

fn run_dev(cli: &Cli, path: Option<&PathBuf>) -> Result<(), CliError> {
    if cli.json {
        return Err(CliError::from_message("DEV_JSON_UNSUPPORTED".to_owned()));
    }
    let mut package_path = None;
    let mut summary = None;
    if let Some(source) = path {
        let context =
            IdentityContext::discover(cli.test_store.as_deref()).map_err(CliError::from_message)?;
        let signing_key = context.signing_key().map_err(CliError::from_message)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| CliError::from_message("DEV_CLOCK_INVALID".to_owned()))?
            .as_nanos();
        let output = std::env::temp_dir().join(format!(
            "smallframe-dev-{}-{nonce}.smallframe",
            std::process::id()
        ));
        summary = Some(pack(source, &output, &signing_key).map_err(CliError::from_message)?);
        package_path = Some(output);
    }
    eprintln!("Smallframe local development only — no deployment, relay, or share link.");
    let mut command = ProcessCommand::new("npm");
    command
        .args(["run", "dev"])
        .env("SMALLFRAME_CANDIDATE", "U")
        .env("SMALLFRAME_PHASE2_DEFAULT", "1");
    if let (Some(output), Some(package)) = (&package_path, &summary) {
        command
            .env("SMALLFRAME_DEV_PACKAGE", output)
            .env("SMALLFRAME_DEV_PACKAGE_DIGEST", &package.package_digest)
            .env("SMALLFRAME_DEV_PUBLISHER_KEY_ID", &package.publisher_key_id);
    }
    let result = command
        .status()
        .map_err(|_| CliError::from_message("DEV_PROCESS_START_FAILED".to_owned()));
    if let Some(output) = package_path {
        let _ = fs::remove_file(output);
    }
    let status = result?;
    if !status.success() {
        return Err(CliError::from_message("DEV_PROCESS_FAILED".to_owned()));
    }
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
        Command::Enroll {
            invite_file,
            api_url,
        } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            let result = enroll_publisher(&context, invite_file.as_deref(), api_url)
                .map_err(CliError::from_message)?;
            emit(&result, cli.json)
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
        Command::Publish {
            path,
            initial_state,
            expires_in,
            show_secrets,
            api_url,
            controller_url,
        } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            let result = publish_package(
                &context,
                path,
                initial_state.as_deref(),
                *expires_in,
                *show_secrets,
                api_url,
                controller_url,
            )
            .map_err(CliError::from_message)?;
            emit(&result, cli.json)
        }
        Command::Room { command } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            match command {
                RoomCommand::Status { room_ref, api_url } => {
                    let result =
                        room_status(&context, room_ref, api_url).map_err(CliError::from_message)?;
                    emit(&result, cli.json)
                }
                RoomCommand::RotateLinks { room_ref, api_url } => {
                    let result = room_rotate_links(&context, room_ref, api_url)
                        .map_err(CliError::from_message)?;
                    emit(&result, cli.json)
                }
                RoomCommand::Revoke { room_ref, api_url } => {
                    let result =
                        room_revoke(&context, room_ref, api_url).map_err(CliError::from_message)?;
                    emit(&result, cli.json)
                }
                RoomCommand::RequestRepair {
                    room_ref,
                    expected_etag,
                    api_url,
                } => {
                    let result =
                        room_request_repair(&context, room_ref, expected_etag.as_deref(), api_url)
                            .map_err(CliError::from_message)?;
                    emit(&result, cli.json)
                }
            }
        }
        Command::Operations { command } => {
            let context = IdentityContext::discover(cli.test_store.as_deref())
                .map_err(CliError::from_message)?;
            match command {
                OperationsCommand::Status { operation_ref } => {
                    let result = if operation_ref == "enrollment" {
                        enrollment_operation_status(&context)
                    } else if let Some(digest) = operation_ref.strip_prefix("upload:") {
                        upload::upload_status(&context, digest)
                    } else {
                        room_operation_status(&context, operation_ref)
                    };
                    emit(&result.map_err(CliError::from_message)?, cli.json)
                }
                OperationsCommand::Resume {
                    operation_ref,
                    show_secrets,
                } => {
                    let result = if operation_ref == "enrollment" {
                        resume_enrollment_operation(&context)
                    } else if let Some(digest) = operation_ref.strip_prefix("upload:") {
                        upload::resume_upload(&context, digest)
                    } else {
                        resume_room_operation(&context, operation_ref, *show_secrets)
                    };
                    emit(&result.map_err(CliError::from_message)?, cli.json)
                }
                OperationsCommand::Abandon { .. } => Err(CliError::from_message(
                    "OPERATION_ABANDON_REQUIRES_SERVER_RECONCILIATION".to_owned(),
                )),
            }
        }
        Command::Export { .. } => Err(CliError::from_message(
            "PACKAGE_EXPORT_NOT_IMPLEMENTED".to_owned(),
        )),
        Command::Dev { path } => run_dev(cli, path.as_ref()),
    }
}

fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(&cli) {
        if cli.json {
            eprintln!(
                "{}",
                json!({"ok":false,"error":{"code":error.code},
                "operationRef":error.operation_ref})
            );
        } else {
            eprintln!("{}", error.detail);
        }
        std::process::exit(i32::from(error.exit));
    }
}
