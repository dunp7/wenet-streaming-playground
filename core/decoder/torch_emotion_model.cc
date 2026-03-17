#include "decoder/torch_emotion_model.h"

#include <algorithm>
#include <memory>
#include <utility>

namespace wenet {

void TorchEmotionModel::Read(const std::string& model_path) {
  torch::DeviceType device = at::kCPU;
#ifdef USE_GPU
  if (torch::cuda::is_available()) {
    device = at::kCUDA;
  }
#endif
  torch::jit::script::Module model = torch::jit::load(model_path, device);
  model_ = std::make_shared<TorchModule>(std::move(model));
  torch::NoGradGuard no_grad;
  model_->eval();

  // Read metadata
  subsampling_rate_ = model_->run_method("subsampling_rate").toInt();
  right_context_ = model_->run_method("right_context").toInt();
  // As configured, emotion classes = 2
  num_emotions_ = 2; 

  torch::jit::setGraphExecutorOptimize(false);
  VLOG(1) << "EmotionModel loaded. subsampling_rate=" << subsampling_rate_
          << " right_context=" << right_context_;
}

TorchEmotionModel::TorchEmotionModel(const TorchEmotionModel& other) {
  right_context_ = other.right_context_;
  subsampling_rate_ = other.subsampling_rate_;
  chunk_size_ = other.chunk_size_;
  num_left_chunks_ = other.num_left_chunks_;
  num_emotions_ = other.num_emotions_;
  model_ = other.model_;
}

void TorchEmotionModel::Reset() {
  offset_ = 0;
  att_cache_ = torch::zeros({0, 0, 0, 0});
  cnn_cache_ = torch::zeros({0, 0, 0, 0});
  final_outs_.clear();
  inter_outs_.clear();
  cached_feature_.clear();
}

void TorchEmotionModel::ForwardEmotionChunk(
    const std::vector<std::vector<float>>& chunk_feats,
    torch::Tensor*, torch::Tensor*) {
  
  int num_frames = cached_feature_.size() + chunk_feats.size();
  if (num_frames == 0) return;
  const int feature_dim = chunk_feats.empty() ? cached_feature_[0].size() : chunk_feats[0].size();
  
  torch::Tensor feats = torch::zeros({1, num_frames, feature_dim}, torch::kFloat);
  for (size_t i = 0; i < cached_feature_.size(); ++i) {
    feats[0][i] = torch::from_blob(
        const_cast<float*>(cached_feature_[i].data()), {feature_dim}, torch::kFloat).clone();
  }
  for (size_t i = 0; i < chunk_feats.size(); ++i) {
    feats[0][cached_feature_.size() + i] = torch::from_blob(
        const_cast<float*>(chunk_feats[i].data()), {feature_dim}, torch::kFloat).clone();
  }

#ifdef USE_GPU
  feats = feats.to(at::kCUDA);
  att_cache_ = att_cache_.to(at::kCUDA);
  cnn_cache_ = cnn_cache_.to(at::kCUDA);
#endif

  int required_cache_size = chunk_size_ * num_left_chunks_;
  std::vector<torch::jit::IValue> inputs = {
      feats, offset_, required_cache_size, att_cache_, cnn_cache_};

  torch::NoGradGuard no_grad;
  auto outputs = model_->get_method("forward_emotion_chunk")(inputs).toTuple()->elements();
  
  torch::Tensor chunk_out = outputs[0].toTensor();
  torch::Tensor intermediate = outputs[1].toTensor();

#ifdef USE_GPU
  chunk_out = chunk_out.to(at::kCPU);
  intermediate = intermediate.to(at::kCPU);
  att_cache_ = outputs[2].toTensor().to(at::kCPU);
  cnn_cache_ = outputs[3].toTensor().to(at::kCPU);
#else
  att_cache_ = outputs[2].toTensor();
  cnn_cache_ = outputs[3].toTensor();
#endif

  offset_ += chunk_out.size(1);

  final_outs_.push_back(std::move(chunk_out));
  if (intermediate.numel() > 0) {
    inter_outs_.push_back(std::move(intermediate));
  }

  // Handle right context cache for next chunk if needed
  cached_feature_.clear();
}

torch::Tensor TorchEmotionModel::ForwardEmotionHead() {
  if (final_outs_.empty()) {
    return torch::zeros({1, num_emotions_});
  }
  
  torch::NoGradGuard no_grad;
  torch::Tensor accumulated_final = torch::cat(final_outs_, /*dim=*/1);
  torch::Tensor accumulated_inter;
  
  if (!inter_outs_.empty()) {
    accumulated_inter = torch::cat(inter_outs_, /*dim=*/1);
  } else {
    // If empty, create an empty tensor with shape (1, T, 0)
    accumulated_inter = torch::zeros({1, accumulated_final.size(1), 0});
  }

#ifdef USE_GPU
  accumulated_final = accumulated_final.to(at::kCUDA);
  accumulated_inter = accumulated_inter.to(at::kCUDA);
#endif

  std::vector<torch::jit::IValue> inputs = {accumulated_final, accumulated_inter};
  torch::Tensor logits = model_->get_method("forward_emotion_head")(inputs).toTensor();

#ifdef USE_GPU
  logits = logits.to(at::kCPU);
#endif

  return logits;
}

}  // namespace wenet
