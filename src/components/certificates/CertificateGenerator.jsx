"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Download, Share2 } from "lucide-react";
import { toast } from "sonner";

const CertificateGenerator = ({ certificateData }) => {
  const canvasRef = useRef(null);
  const { userName, courseTitle, completionDate, certificateId, chapterCount } = certificateData;

  useEffect(() => {
    if (canvasRef.current) {
      generateCertificate();
    }
  }, [certificateData]);

  const generateCertificate = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    // Set canvas size (A4 landscape ratio)
    canvas.width = 1200;
    canvas.height = 850;

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#667eea");
    gradient.addColorStop(0.5, "#764ba2");
    gradient.addColorStop(1, "#f093fb");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 8;
    ctx.strokeRect(40, 40, canvas.width - 80, canvas.height - 80);

    // Inner border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 2;
    ctx.strokeRect(60, 60, canvas.width - 120, canvas.height - 120);

    // Logo/Title area
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.fillText("InnoVision", canvas.width / 2, 150);

    // Certificate title
    ctx.font = "36px Georgia";
    ctx.fillText("CERTIFICATE OF COMPLETION", canvas.width / 2, 220);

    // Decorative line
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2 - 200, 240);
    ctx.lineTo(canvas.width / 2 + 200, 240);
    ctx.stroke();

    // "This is to certify that"
    ctx.font = "24px Georgia";
    ctx.fillText("This is to certify that", canvas.width / 2, 300);

    // User name (highlighted)
    ctx.font = "bold 42px Georgia";
    ctx.fillStyle = "#ffd700";
    ctx.fillText(userName, canvas.width / 2, 360);

    // "has successfully completed"
    ctx.fillStyle = "#ffffff";
    ctx.font = "24px Georgia";
    ctx.fillText("has successfully completed the course", canvas.width / 2, 410);

    // Course title (highlighted)
    ctx.font = "bold 32px Georgia";
    ctx.fillStyle = "#ffd700";
    const maxWidth = 900;
    const words = courseTitle.split(" ");
    let line = "";
    let y = 470;

    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + " ";
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && i > 0) {
        ctx.fillText(line, canvas.width / 2, y);
        line = words[i] + " ";
        y += 40;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, canvas.width / 2, y);

    // Details section
    ctx.fillStyle = "#ffffff";
    ctx.font = "20px Arial";
    const detailsY = y + 80;
    ctx.fillText(`Completed on: ${completionDate}`, canvas.width / 2, detailsY);
    ctx.fillText(`Total Chapters: ${chapterCount}`, canvas.width / 2, detailsY + 35);

    // Certificate ID
    ctx.font = "16px monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText(`Certificate ID: ${certificateId}`, canvas.width / 2, detailsY + 75);

    // Footer
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(200, canvas.height - 120);
    ctx.lineTo(canvas.width - 200, canvas.height - 120);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "18px Arial";
    ctx.fillText("InnoVision Learning Platform", canvas.width / 2, canvas.height - 80);
    ctx.font = "14px Arial";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText(`Verify at: innovision.com/verify/${certificateId}`, canvas.width / 2, canvas.height - 50);
  };

  const downloadCertificate = () => {
    const canvas = canvasRef.current;
    const link = document.createElement("a");
    link.download = `InnoVision_Certificate_${certificateId}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast.success("Certificate downloaded successfully!");
  };

  const shareCertificate = async () => {
    const canvas = canvasRef.current;

    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const file = new File([blob], `certificate_${certificateId}.png`, { type: "image/png" });

      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: "My InnoVision Certificate",
          text: `I completed "${courseTitle}" on InnoVision!`,
          files: [file],
        });
        toast.success("Certificate shared successfully!");
      } else {
        // Fallback: copy link
        const url = `${window.location.origin}/verify/${certificateId}`;
        await navigator.clipboard.writeText(url);
        toast.success("Certificate link copied to clipboard!");
      }
    } catch (error) {
      console.error("Error sharing:", error);
      toast.error("Failed to share certificate");
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 p-6">
      <canvas
        ref={canvasRef}
        className="border-4 border-gray-200 dark:border-gray-700 rounded-lg shadow-2xl max-w-full h-auto"
      />

      <div className="flex gap-4">
        <Button onClick={downloadCertificate} className="gap-2">
          <Download className="h-4 w-4" />
          Download Certificate
        </Button>
        <Button onClick={shareCertificate} variant="outline" className="gap-2">
          <Share2 className="h-4 w-4" />
          Share
        </Button>
      </div>
    </div>
  );
};

export default CertificateGenerator;
