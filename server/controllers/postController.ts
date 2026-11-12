
import { Response } from "express";
import { AuthRequest } from "../middlewares/authMiddlewware.js";
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import { cloudinary } from "../config/cloudinary.js";
import { Generation } from "../models/Generation.js";
import { Post } from "../models/Post.js";

// ==========================================
// 1. GEMINI: Generate caption and image prompt
// ==========================================

const generatePostContent = async (
    prompt: string,
    tone: string
): Promise<{ content: string; imagePrompt: string }> => {

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error("Gemini API key is missing.");
    }

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",

    contents: `
        Generate a social media post based on this prompt: "${prompt}".

        Tone: ${tone}.

        Include relevant hashtags.

        Return ONLY valid JSON:

        {
            "content": "Social media caption with hashtags",
            "imagePrompt": "Detailed image generation prompt"
        }
    `,

    config: {
        temperature: 0.7,
        responseMimeType: "application/json"
    }
});

    const rawText = response.text || "";

    if (!rawText) {
        throw new Error("Gemini returned an empty response.");
    }

    try {
        const data = JSON.parse(rawText);

        if (!data.content || !data.imagePrompt) {
            throw new Error("Invalid Gemini response structure.");
        }

        return {
            content: data.content,
            imagePrompt: data.imagePrompt
        };

    } catch (error) {
        console.error("Gemini JSON parsing error:", rawText);
        throw new Error("Failed to parse Gemini response.");
    }
};


// ==========================================
// 2. CLOUDFLARE: Generate image using FLUX
// ==========================================

const generateCloudflareImage = async (
    prompt: string
): Promise<string> => {

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
        throw new Error("Cloudflare credentials are missing.");
    }

    const model = "@cf/black-forest-labs/flux-1-schnell";

    const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

    const response = await axios.post(
        url,
        {
            prompt,
            steps: 4
        },
        {
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json"
            },
            timeout: 120000
        }
    );

    const base64Image = response.data?.result?.image;

    if (!base64Image) {
        throw new Error(
            response.data?.errors?.[0]?.message ||
            "Cloudflare failed to generate an image."
        );
    }

    return base64Image;
};


// ==========================================
// 3. Upload generated image to Cloudinary
// ==========================================

const uploadToCloudinary = async (
    base64Image: string
): Promise<string> => {

    const uploadResult = await cloudinary.uploader.upload(
        `data:image/jpeg;base64,${base64Image}`,
        {
            folder: "ai-generations",
            resource_type: "image"
        }
    );

    return uploadResult.secure_url;
};


// ==========================================
// 4. GENERATE POST
// POST /api/posts/generate
// ==========================================

export const generatePost = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {

        const { prompt, tone, generateImage } = req.body;

        if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
            res.status(400).json({
                message: "Please provide a valid prompt."
            });
            return;
        }

        // Step 1: Generate caption and image prompt using Gemini

        const { content, imagePrompt } = await generatePostContent(
            prompt.trim(),
            tone || "Professional"
        );

        let mediaUrl = "";
        let imageError = "";

        // Step 2: Generate image using Cloudflare

        if (generateImage) {

            try {

                const base64Image = await generateCloudflareImage(
                    imagePrompt
                );

                // Step 3: Store image permanently on Cloudinary

                mediaUrl = await uploadToCloudinary(base64Image);

            } catch (error: any) {

                imageError =
                    error.response?.data?.errors?.[0]?.message ||
                    error.message ||
                    "Image generation failed.";

                console.error(
                    "Cloudflare image generation error:",
                    error.response?.data || error.message
                );
            }
        }

        // Step 4: Save generation in MongoDB

        const generation = await Generation.create({

            user: req.user._id,

            prompt,

            content,

            mediaUrl,

            mediaType: mediaUrl ? "image" : undefined,

            tone: tone || "Professional"

        });

        // Preserve the existing response structure.
        // Return an image warning only if image generation failed.

        if (imageError) {
            res.json({
                ...generation.toObject(),
                imageError
            });
            return;
        }

        res.json(generation);

    } catch (error: any) {

        console.error("Generate post error:", error);

        res.status(500).json({
            message: error?.message || "Server error"
        });
    }
};


// ==========================================
// 5. GET GENERATIONS
// GET /api/posts/generations
// ==========================================

export const getGenerations = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {

        const generations = await Generation.find({
            user: req.user._id
        }).sort({ createdAt: -1 });

        res.json(generations);

    } catch (error: any) {

        res.status(500).json({
            message: error?.message || "Server error"
        });
    }
};


// ==========================================
// 6. GET POSTS
// GET /api/posts
// ==========================================

export const getPosts = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {

        const posts = await Post.find({
            user: req.user._id
        });

        res.json(posts);

    } catch (error: any) {

        res.status(500).json({
            message: error?.message || "Server error"
        });
    }
};


// ==========================================
// 7. SCHEDULE POST
// POST /api/posts
// ==========================================

export const schedulePost = async (
    req: AuthRequest,
    res: Response
): Promise<void> => {

    try {

        const {
            content,
            platforms,
            scheduledFor,
            status
        } = req.body;

        // Parse platforms if received as a string

        let parsedPlatforms = platforms;

        if (typeof platforms === "string") {

            try {
                parsedPlatforms = JSON.parse(platforms);
            } catch {
                parsedPlatforms = platforms.split(",");
            }
        }

        let mediaUrl: string | undefined = req.body.mediaUrl;

        let mediaType: "image" | "video" | undefined =
            req.body.mediaType;

        // Upload media if a file is provided

        if (req.file) {

            const result = await new Promise<any>(
                (resolve, reject) => {

                    const stream = cloudinary.uploader.upload_stream(
                        {
                            resource_type: "auto",
                            folder: "social-scheduler"
                        },
                        (error, result) => {

                            if (error) {
                                reject(error);
                            } else {
                                resolve(result);
                            }
                        }
                    );

                    stream.end(req.file!.buffer);
                }
            );

            mediaUrl = result.secure_url;

            mediaType =
                result.resource_type === "video"
                    ? "video"
                    : "image";
        }

        // Save scheduled post

        const post = await Post.create({

            user: req.user._id,

            content,

            platforms: parsedPlatforms,

            mediaUrl,

            mediaType,

            scheduledFor,

            status

        });

        res.status(201).json(post);

    } catch (error: any) {

        console.error("Schedule post error:", error);

        res.status(500).json({
            message: error?.message || "Server error"
        });
    }
};
