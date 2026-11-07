import nodemailer from "nodemailer";
import type { NotificationEvent } from "./event";
import { integer } from "./config";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function email(event: NotificationEvent, from: string) {
  const base = {
    from,
    to: { name: event.recipient.name, address: event.recipient.email },
    messageId: `<${event.eventId}@rolefit.local>`,
  };
  if (event.eventType === "job.deadline.reminder.v1") {
    const date = new Date(event.deadline).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    return {
      ...base,
      subject: `Reminder: ${event.jobTitle} closes soon`,
      text: `Hello ${event.recipient.name},\n\n${event.jobTitle} closes on ${date}. You prepared a resume for this job but have not applied yet.\n`,
      html: `<p>Hello ${escapeHtml(event.recipient.name)},</p><p><strong>${escapeHtml(event.jobTitle)}</strong> closes on ${escapeHtml(date)}. You prepared a resume for this job but have not applied yet.</p>`,
    };
  }
  return {
    ...base,
    subject: `Application update: ${event.jobTitle}`,
    text: `Hello ${event.recipient.name},\n\nYour application for ${event.jobTitle} changed from ${event.previousStatus} to ${event.newStatus}.\nApplication: ${event.applicationId}\n`,
    html: `<p>Hello ${escapeHtml(event.recipient.name)},</p><p>Your application for <strong>${escapeHtml(event.jobTitle)}</strong> changed from ${escapeHtml(event.previousStatus)} to <strong>${escapeHtml(event.newStatus)}</strong>.</p><p>Application: ${escapeHtml(event.applicationId)}</p>`,
  };
}
export function createMailer() {
  const secure = process.env.SMTP_SECURE === "true";
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: integer("SMTP_PORT", 1025),
    secure,
    ...(process.env.SMTP_USER
      ? {
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD || "",
          },
        }
      : {}),
    requireTLS: process.env.SMTP_REQUIRE_TLS === "true",
    tls: { rejectUnauthorized: true },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
  return async (event: NotificationEvent) => {
    const result = await transport.sendMail(
      email(
        event,
        process.env.SMTP_FROM || "RoleFit <notifications@rolefit.test>",
      ),
    );
    if (result.rejected.length || !result.accepted.length)
      throw Object.assign(new Error("Recipient rejected"), {
        responseCode: 550,
      });
  };
}
export function isPermanent(error: unknown): boolean {
  const code = (error as { responseCode?: number })?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}
